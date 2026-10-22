import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../core/store.js';
import { AuthService } from '../core/auth.js';
import { GoogleDrive } from '../core/drive.js';
import { createHash } from 'node:crypto';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const connected = () => {
  const repo = new MemoryStore();
  repo.saveAccount({
    id: 'a',
    email: 'a@example.com',
    name: 'A',
    permissionId: 'a',
    connections: 1,
    ready: true,
  });
  repo.saveConnection({
    id: 'c',
    accountId: 'a',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh-a',
    accessToken: 'access-a',
    expiresAt: Date.now() + 3600000,
  });
  const auth = new AuthService(repo, async () => {});
  return { repo, auth, drive: new GoogleDrive(auth) };
};
afterEach(() => vi.unstubAllGlobals());
describe('真实授权接口适配与连接池', () => {
  it('loopback授权校验state与PKCE并拒绝错误回调', async () => {
    const repo = new MemoryStore();
    repo.saveConnection({
      id: 'new',
      clientId: 'desktop-client',
      clientSecret: 'client-secret',
      expiresAt: 0,
    });
    const nativeFetch = globalThis.fetch;
    let challenge = '';
    let redirect = '';
    let wrongStatus = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string | Request, options?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, options);
        if (url.includes('/token')) {
          const body = options!.body as URLSearchParams;
          expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
            challenge,
          );
          expect(body.get('redirect_uri')).toBe(redirect);
          return json({
            access_token: 'oauth-access',
            refresh_token: 'oauth-refresh',
            expires_in: 3600,
          });
        }
        return json({
          user: {
            permissionId: 'verified',
            emailAddress: 'verified@example.com',
            displayName: 'Verified',
          },
        });
      }),
    );
    const auth = new AuthService(repo, async (raw) => {
      const u = new URL(raw);
      challenge = u.searchParams.get('code_challenge')!;
      redirect = u.searchParams.get('redirect_uri')!;
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      const bad = new URL(redirect);
      bad.search = new URLSearchParams({
        state: '错'.repeat(u.searchParams.get('state')!.length),
        code: 'wrong',
      }).toString();
      wrongStatus = (await fetch(bad)).status;
      const good = new URL(redirect);
      good.search = new URLSearchParams({
        state: u.searchParams.get('state')!,
        code: 'valid-code',
      }).toString();
      await fetch(good);
    });
    await auth.authorize('new');
    expect(wrongStatus).toBe(400);
    expect(repo.accounts()[0].id).toBe('verified');
  });
  it('同一个client下不同Gmail导入不覆盖，客户端配置不当成已授权', async () => {
    const repo = new MemoryStore(),
      auth = new AuthService(repo, async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: RequestInit) => {
        if (String(url).includes('/token')) {
          const r = (opts.body as URLSearchParams).get('refresh_token')!;
          return json({ access_token: r, expires_in: 3600 });
        }
        const token = (opts.headers as Record<string, string>).Authorization.split(' ')[1];
        return json({
          user: { permissionId: token, emailAddress: `${token}@example.com`, displayName: token },
        });
      }),
    );
    await auth.importJson(
      JSON.stringify({ installed: { client_id: 'client', client_secret: 'secret' } }),
    );
    expect(repo.accounts()).toHaveLength(0);
    for (const refresh_token of ['one', 'two'])
      await auth.importJson(
        JSON.stringify({ client_id: 'client', client_secret: 'secret', refresh_token }),
      );
    expect(repo.accounts().map((a) => a.id)).toEqual(['one', 'two']);
    expect(repo.connections().filter((c) => c.accountId)).toHaveLength(2);
  });
  it('连接池不跨账号选取token，且遵守每连接容量', async () => {
    const { repo, auth } = connected();
    repo.saveSettings({ concurrency: 8, accountConcurrency: 4, connectionConcurrency: 1 });
    repo.saveConnection({
      id: 'other',
      accountId: 'b',
      clientId: 'other',
      clientSecret: 'secret',
      accessToken: 'wrong',
      expiresAt: Date.now() + 3600000,
    });
    const first = await auth.acquire('a');
    let acquired = false;
    const second = auth.acquire('a').then((v) => {
      acquired = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(acquired).toBe(false);
    first.release();
    const next = await second;
    expect(next.connection.accessToken).toBe('access-a');
    next.release();
  });
  it('同时到期请求只触发一次刷新', async () => {
    const { repo, auth } = connected();
    const c = repo.connections()[0];
    c.expiresAt = 0;
    repo.saveConnection(c);
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/token')) {
          refreshes++;
          await new Promise((r) => setTimeout(r, 20));
          return json({ access_token: 'renewed', expires_in: 3600 });
        }
        return json({
          user: { permissionId: 'a', emailAddress: 'a@example.com', displayName: 'A' },
        });
      }),
    );
    const requests = await Promise.all([auth.acquire('a'), auth.acquire('a')]);
    expect(refreshes).toBe(1);
    requests.forEach((r) => r.release());
  });
  it('刷新后身份不匹配使连接失效', async () => {
    const { repo, auth } = connected();
    const c = repo.connections()[0];
    c.expiresAt = 0;
    repo.saveConnection(c);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/token')
          ? json({ access_token: 'mismatch', expires_in: 3600 })
          : json({ user: { permissionId: 'b', emailAddress: 'b@example.com' } }),
      ),
    );
    await expect(auth.acquire('a')).rejects.toThrow('身份发生变化');
    expect(repo.connections()[0].disabled).toBe(true);
  });
});
describe('Drive REST分页和错误边界', () => {
  it('读取所有权限页', async () => {
    const { drive } = connected();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls.push(String(url));
        return json(
          url.searchParams.get('pageToken')
            ? { permissions: [{ id: '2', type: 'user', role: 'reader' }] }
            : { permissions: [{ id: '1', type: 'user', role: 'writer' }], nextPageToken: 'next' },
        );
      }),
    );
    expect((await drive.permissions('a', 'file')).map((p) => p.id)).toEqual(['1', '2']);
    expect(calls).toHaveLength(2);
  });
  it('不完整扫描不返回complete=true', async () => {
    const { drive } = connected();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ files: [], incompleteSearch: true })),
    );
    expect((await drive.list('a', 'all')).complete).toBe(false);
  });
  it('404不当成永久删除', async () => {
    const { drive } = connected();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'not found' } }, 404)),
    );
    await expect(drive.get('a', 'missing')).rejects.toThrow('不可访问');
  });
  it('网络写入超时不在传输层自动重发', async () => {
    const { drive } = connected();
    const fetch = vi.fn(async () => {
      throw new Error('timeout');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      drive.createPermission('a', 'file', {
        type: 'user',
        role: 'writer',
        emailAddress: 'b@example.com',
      }),
    ).rejects.toThrow('对账');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('传递resource key请求头且文件ID做URL转义', async () => {
    const { drive } = connected();
    drive.registerKey('file', 'key');
    const fetch = vi.fn(async () => json({ id: 'file', name: 'name', parents: [] }));
    vi.stubGlobal('fetch', fetch);
    await drive.get('a', 'file');
    const opts = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect((opts[1].headers as Record<string, string>)['X-Goog-Drive-Resource-Keys']).toBe(
      'file/key',
    );
  });
});

describe('扫描与分页恢复', () => {
  it.each([1, 2])('最大层级 %s 只请求对应目录并完整读取分页', async (maxDepth) => {
    const { drive } = connected();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith('/root'))
          return json({ id: 'root-id', mimeType: 'application/vnd.google-apps.folder' });
        const q = url.searchParams.get('q')!;
        calls.push(q);
        if (q.includes("'root-id'"))
          return json(
            url.searchParams.has('pageToken')
              ? { files: [{ id: 'root-file', name: 'Root file', parents: ['root-id'], size: '1' }] }
              : {
                  files: [
                    {
                      id: 'one',
                      name: 'One',
                      mimeType: 'application/vnd.google-apps.folder',
                      parents: ['root-id'],
                    },
                  ],
                  nextPageToken: 'next',
                },
          );
        if (q.includes("'one'"))
          return json({
            files: [
              {
                id: 'two',
                name: 'Two',
                mimeType: 'application/vnd.google-apps.folder',
                parents: ['one'],
              },
            ],
          });
        throw new Error('不应请求更深目录或全局文件');
      }),
    );
    const result = await drive.list('a', 'all', true, false, undefined, maxDepth);
    expect(result.maxDepth).toBe(maxDepth);
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(maxDepth === 1 ? 2 : 3);
    expect(result.files.find((f) => f.id === 'root-file')).toBeDefined();
    expect(
      result.files.find((f) => f.id === (maxDepth === 1 ? 'one' : 'two'))?.childrenScanned,
    ).toBe(false);
    expect(result.files.every((f) => f.depth! <= maxDepth)).toBe(true);
  });
  it('指定目录从其子项算第1层，拒绝非正整数层级', async () => {
    const { drive } = connected();
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls.push(url);
        return url.pathname.endsWith('/folder')
          ? json({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
          : json({
              files: [
                {
                  id: 'child',
                  name: 'Child',
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: ['folder'],
                },
              ],
            });
      }),
    );
    const scan = await drive.list('a', 'folder', true, false, undefined, 1);
    expect(calls[1].searchParams.get('q')).toContain("'folder' in parents");
    expect(scan.files[0].depth).toBe(1);
    expect(scan.files[0].childrenScanned).toBe(false);
    for (const depth of [0, -1, 1.5, NaN])
      await expect(drive.list('a', 'all', true, false, undefined, depth)).rejects.toThrow('整数');
    expect(calls).toHaveLength(2);
  });
  it('全盘用全局分页扫描，不逐目录请求且第一页不发送空token', async () => {
    const { drive } = connected();
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith('/root'))
          return json({ id: 'root', mimeType: 'application/vnd.google-apps.folder' });
        calls.push(url);
        expect(url.pathname).toBe('/drive/v3/files');
        expect(url.searchParams.get('q')).toBe('trashed = false');
        return json(
          url.searchParams.has('pageToken')
            ? { files: [{ id: 'child', name: 'Child', parents: ['folder'], size: '900' }] }
            : {
                files: [
                  { id: 'folder', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
                ],
                nextPageToken: 'page2',
              },
        );
      }),
    );
    const progress: { pages: number; items: number }[] = [];
    const scan = await drive.list('a', 'all', true, false, (p) => progress.push(p));
    expect(progress).toEqual([
      { pages: 1, items: 1 },
      { pages: 2, items: 2 },
    ]);
    expect(scan.complete).toBe(true);
    expect(scan.files).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.has('pageToken')).toBe(false);
    expect(calls[0].searchParams.get('fields')).toContain('size');
    expect(calls[0].searchParams.get('fields')).toContain('permissions(id,type,role,emailAddress');
    expect(calls[0].searchParams.get('fields')).toContain('createdTime');
    expect(calls[0].searchParams.get('fields')).toContain('quotaBytesUsed');
  });
  it('权限令牌失效从第一页重读，丢弃旧页并去重', async () => {
    const { drive } = connected();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls++;
        if (calls === 1) {
          expect(url.searchParams.has('pageToken')).toBe(false);
          return json({ permissions: [{ id: 'stale' }], nextPageToken: 'expired' });
        }
        if (calls === 2) return json({ error: { errors: [{ reason: 'pageTokenExpired' }] } }, 403);
        if (calls === 3) {
          expect(url.searchParams.has('pageToken')).toBe(false);
          return json({ permissions: [{ id: 'new' }], nextPageToken: 'valid' });
        }
        return json({ permissions: [{ id: 'new' }, { id: 'last' }] });
      }),
    );
    expect((await drive.permissions('a', 'file')).map((p) => p.id)).toEqual(['new', 'last']);
    expect(calls).toBe(4);
  });
  it('持续失效有限重试，不陷入无限扫描', async () => {
    const { drive } = connected();
    const mock = vi.fn(async (url: URL) =>
      url.pathname.endsWith('/root')
        ? json({ id: 'root' })
        : json({ error: { errors: [{ reason: 'pageTokenExpired' }] } }, 403),
    );
    vi.stubGlobal('fetch', mock);
    await expect(drive.list('a', 'all', true)).rejects.toThrow('pageTokenExpired');
    expect(mock).toHaveBeenCalledTimes(3);
  });
});

describe('同Gmail多客户端真实调度路径', () => {
  it('同一账号的两套授权文件连接同时承载不同文件请求', async () => {
    const { repo, drive } = connected();
    repo.saveConnection({
      id: 'c2',
      accountId: 'a',
      clientId: 'client2',
      clientSecret: 'secret2',
      accessToken: 'access-a2',
      expiresAt: Date.now() + 3600000,
    });
    repo.saveSettings({ concurrency: 12, accountConcurrency: 12, connectionConcurrency: 1 });
    let active = 0,
      peak = 0;
    const tokens = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, opts: RequestInit) => {
        tokens.add((opts.headers as Record<string, string>).Authorization);
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return json({
          id: url.pathname.split('/').pop(),
          name: 'file',
          parents: [],
          mimeType: 'application/pdf',
        });
      }),
    );
    await Promise.all([drive.get('a', 'file1'), drive.get('a', 'file2')]);
    expect(peak).toBe(2);
    expect(tokens).toEqual(new Set(['Bearer access-a', 'Bearer access-a2']));
  });
});
