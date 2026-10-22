import {
  FOLDER,
  type DriveApi,
  type FileEntry,
  type Permission,
  type ScanResult,
  type ScanProgress,
} from './types.js';
import { AuthService } from './auth.js';
import { OperationError } from './engine.js';
import { apiEvent, checkRequestPause, interruptibleWait } from './telemetry.js';

const fields =
  'id,name,mimeType,parents,size,quotaBytesUsed,createdTime,modifiedTime,webViewLink,ownedByMe,owners(displayName,emailAddress,permissionId),trashed,driveId,resourceKey,capabilities,writersCanShare,copyRequiresWriterPermission,inheritedPermissionsDisabled,appProperties,permissions(id,type,role,emailAddress,domain,displayName,pendingOwner,deleted,view,permissionDetails)';
const permFields =
  'id,type,role,emailAddress,domain,displayName,pendingOwner,deleted,view,permissionDetails';
const escapeQuery = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export class GoogleDrive implements DriveApi {
  private resourceKeys = new Map<string, string>();
  constructor(private auth: AuthService) {}
  registerKey(id: string, key: string) {
    this.resourceKeys.set(id, key);
  }
  private async request<T>(
    account: string,
    path: string,
    method = 'GET',
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
    url.search = new URLSearchParams(
      Object.entries({ supportsAllDrives: 'true', ...query }).filter(([, value]) => value !== ''),
    ).toString();
    for (let attempt = 0; attempt < 5; attempt++) {
      checkRequestPause();
      const { connection: c, release, ticket } = await this.auth.acquire(account);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${c.accessToken}`,
          'Content-Type': 'application/json',
        };
        const keys = [...this.resourceKeys].map(([id, key]) => `${id}/${key}`).slice(-100);
        if (keys.length) headers['X-Goog-Drive-Resource-Keys'] = keys.join(',');
        if (attempt > 0) apiEvent({ type: 'retry', message: '网络请求重试' });
        apiEvent({ type: 'request', method });
        this.auth.recordRequest?.(account);
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          if (method === 'GET' && attempt < 4) {
            await delay(400 * 2 ** attempt);
            continue;
          }
          throw new OperationError('网络中断或超时，写入结果需要重新对账', 503);
        }
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          return (await res.json()) as T;
        }
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; errors?: { reason: string }[] };
        };
        const reason = data.error?.errors?.[0]?.reason || '';
        if (res.status === 401 && attempt < 4) {
          this.auth.invalidate(c.id);
          continue;
        }
        if (res.status === 403 && reason === 'accessNotConfigured' && attempt < 4) {
          this.auth.invalidate(c.id, true, '该客户端项目未启用 Drive API');
          continue;
        }
        const limited =
          res.status === 429 ||
          (res.status === 403 &&
            [
              'rateLimitExceeded',
              'userRateLimitExceeded',
              'sharingRateLimitExceeded',
              'dailyLimitExceeded',
            ].includes(reason));
        if (limited) {
          const retry = res.headers.get('retry-after');
          const retryMs = retry
            ? /^\d+(?:\.\d+)?$/.test(retry.trim())
              ? Number(retry) * 1000
              : Math.max(0, Date.parse(retry) - Date.now())
            : 0;
          const wait = Math.max(
            Number.isFinite(retryMs) ? retryMs : 0,
            Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 1000,
            reason === 'sharingRateLimitExceeded' || reason === 'dailyLimitExceeded' ? 60000 : 0,
          );
          const code = reason || 'userRateLimitExceeded';
          apiEvent({
            type: 'limit',
            message: `${code}；统一等待至少 ${Math.ceil(wait / 1000)} 秒，并降低并发`,
          });
          if (ticket && this.auth.rateLimit) this.auth.rateLimit(c, code, wait, ticket);
          else {
            this.auth.cooldown(c.id, wait);
            await interruptibleWait(wait);
          }
          // Sharing/daily caps need a longer cooling period, not repeated invitations.
          if (attempt < 4 && !['sharingRateLimitExceeded', 'dailyLimitExceeded'].includes(reason))
            continue;
        }
        if (method === 'GET' && res.status >= 500 && attempt < 4) {
          await delay(400 * 2 ** attempt);
          continue;
        }
        throw new OperationError(
          res.status === 404
            ? '对象不存在或当前账号不可访问'
            : `Google API ${res.status}：${reason || data.error?.message || '请求失败'}`,
          res.status,
          reason,
        );
      } finally {
        release();
      }
    }
    throw new OperationError('请求重试次数已用尽', 429);
  }
  async get(a: string, id: string) {
    const f = await this.request<FileEntry>(
      a,
      `files/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      { fields },
    );
    f.parents ??= [];
    if (f.resourceKey) this.resourceKeys.set(f.id, f.resourceKey);
    return f;
  }
  private async pages<T extends { id: string }>(
    a: string,
    path: string,
    key: string,
    query: Record<string, string>,
    onPage?: (count: number) => void,
  ) {
    for (let restart = 0; restart < 2; restart++) {
      const out = new Map<string, T>(),
        tokens = new Set<string>();
      let token = '',
        incomplete = false;
      try {
        do {
          const d = await this.request<Record<string, unknown>>(a, path, 'GET', undefined, {
            ...query,
            ...(token ? { pageToken: token } : {}),
          });
          for (const item of (d[key] || []) as T[]) out.set(item.id, item);
          incomplete ||= d.incompleteSearch === true;
          onPage?.(out.size);
          token = String(d.nextPageToken || '');
          if (token && tokens.has(token))
            throw new OperationError('Google 返回重复分页令牌，请重新扫描', 409);
          if (token) tokens.add(token);
          if (out.size > 100000) throw new OperationError('扫描超过10万项，请缩小目录范围', 413);
        } while (token);
        return { items: [...out.values()], incomplete };
      } catch (e) {
        if (
          restart === 0 &&
          /pageTokenExpired|invalidPageToken|page.?token.*(?:invalid|expired)/i.test(
            e instanceof Error ? e.message : String(e),
          )
        )
          continue;
        throw e;
      }
    }
    throw new OperationError('分页令牌持续失效，请稍后重新扫描', 409);
  }
  async list(
    a: string,
    parent: string,
    recursive = false,
    trashed = false,
    onProgress?: (progress: ScanProgress) => void,
    maxDepth?: number,
    knownFolder?: FileEntry,
  ): Promise<ScanResult> {
    let pages = 0;
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1000))
      throw new OperationError('最大扫描层级须为1到1000的整数', 400);
    if (maxDepth !== undefined && (trashed || ['owned', 'shared'].includes(parent)))
      throw new OperationError('层级限制仅适用于全部文件或指定目录', 400);
    let global = ['all', 'owned', 'shared'].includes(parent);
    let rootId: string | undefined;
    let rootFolder: FileEntry | undefined;
    if (global && !trashed) {
      rootFolder = await this.get(a, 'root');
      rootId = rootFolder.id;
    }
    if (global && maxDepth !== undefined) {
      parent = rootId!;
      global = false;
    }
    if (!trashed && !global) {
      const folder =
        rootFolder || (knownFolder?.id === parent ? knownFolder : await this.get(a, parent));
      if (folder.mimeType !== FOLDER) throw new OperationError('扫描路径必须是文件夹', 400);
      if (folder.capabilities?.canListChildren === false)
        return {
          maxDepth,
          rootId: folder.id,
          files: [],
          complete: false,
          warnings: ['当前账号无法完整读取目录内容'],
        };
      parent = folder.id;
      rootId = folder.id;
    }
    const files = new Map<string, FileEntry>(),
      seen = new Set<string>();
    const queue = [{ id: parent, path: '', depth: 0 }];
    const warnings: string[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      const q = trashed
        ? 'trashed = true'
        : parent === 'all'
          ? 'trashed = false'
          : parent === 'owned'
            ? "trashed = false and 'me' in owners"
            : parent === 'shared'
              ? 'trashed = false and sharedWithMe = true'
              : "trashed = false and '" + escapeQuery(current.id) + "' in parents";
      const d = await this.pages<FileEntry>(
        a,
        'files',
        'files',
        {
          q,
          pageSize: '1000',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: 'true',
          fields: 'nextPageToken,incompleteSearch,files(' + fields + ')',
          orderBy: 'folder,name',
        },
        (count) => onProgress?.({ pages: ++pages, items: files.size + count }),
      );
      if (d.incomplete) warnings.push('Google 返回 incompleteSearch，结果不完整');
      for (const f of d.items) {
        f.parents ??= [];
        f.path = current.path;
        f.depth = current.depth + 1;
        files.set(f.id, f);
        if (f.resourceKey) this.resourceKeys.set(f.id, f.resourceKey);
        if (!global && !trashed && f.mimeType === FOLDER) f.childrenScanned = false;
        if (
          recursive &&
          !global &&
          !trashed &&
          f.mimeType === FOLDER &&
          (maxDepth === undefined || f.depth < maxDepth)
        ) {
          if (f.capabilities?.canListChildren === false) warnings.push('无法读取子目录：' + f.name);
          else {
            f.childrenScanned = true;
            queue.push({ id: f.id, path: current.path + '/' + f.name, depth: current.depth + 1 });
          }
        }
      }
      if (files.size > 100000) throw new OperationError('扫描超过10万项，请缩小目录范围', 413);
    }
    return {
      maxDepth,
      rootId,
      files: [...files.values()],
      complete: !warnings.length,
      warnings: [...new Set(warnings)],
    };
  }
  async permissions(a: string, id: string) {
    const d = await this.pages<Permission>(
      a,
      'files/' + encodeURIComponent(id) + '/permissions',
      'permissions',
      {
        pageSize: '100',
        includePermissionsForView: 'published',
        fields: 'nextPageToken,permissions(' + permFields + ')',
      },
    );
    return d.items;
  }
  createPermission(a: string, id: string, p: Partial<Permission>, notify = false) {
    return this.request<Permission>(a, `files/${encodeURIComponent(id)}/permissions`, 'POST', p, {
      sendNotificationEmail: String(p.pendingOwner ? true : notify),
      fields: permFields,
    });
  }
  updatePermission(a: string, id: string, pid: string, p: Partial<Permission>, transfer = false) {
    return this.request<Permission>(
      a,
      `files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`,
      'PATCH',
      p,
      {
        ...(transfer ? { transferOwnership: 'true' } : {}),
        fields: permFields,
      },
    );
  }
  deletePermission(a: string, id: string, pid: string) {
    return this.request<void>(
      a,
      `files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(pid)}`,
      'DELETE',
    );
  }
  update(a: string, id: string, body: Record<string, unknown>, q: Record<string, string> = {}) {
    return this.request<FileEntry>(a, `files/${encodeURIComponent(id)}`, 'PATCH', body, {
      fields,
      ...q,
    });
  }
  create(a: string, body: Record<string, unknown>) {
    return this.request<FileEntry>(a, 'files', 'POST', body, { fields });
  }
  copy(a: string, id: string, body: Record<string, unknown>) {
    return this.request<FileEntry>(a, `files/${encodeURIComponent(id)}/copy`, 'POST', body, {
      fields,
    });
  }
  async findOperation(a: string, marker: string) {
    const d = await this.request<{ files: FileEntry[] }>(a, 'files', 'GET', undefined, {
      q: `trashed = false and appProperties has { key='driveWorkbench' and value='${escapeQuery(marker)}' }`,
      fields: `files(${fields})`,
      pageSize: '10',
    });
    if (d.files.length > 1) throw new OperationError('发现多个操作关联对象，请人工核对', 409);
    return d.files[0];
  }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
