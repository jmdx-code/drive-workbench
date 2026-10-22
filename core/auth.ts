import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Repository } from './store.js';
import type { Connection, RuntimeLimits } from './types.js';
import { AdaptiveLimits, type RateTicket } from './limiter.js';
import { checkRequestPause, interruptibleWait, apiEvent } from './telemetry.js';
import { OperationError } from './engine.js';
type Identity = {
  displayName: string;
  emailAddress: string;
  permissionId: string;
  photoLink?: string;
};

export class AuthService {
  private refreshing = new Map<string, Promise<Connection>>();
  private counts = new Map<string, number>();
  private limits = new AdaptiveLimits();
  private projectCounts = new Map<string, number>();
  private requests = new Map<string, number[]>();
  private index = 0;
  private profiles = new Map<string, Identity>();
  constructor(
    private repo: Repository,
    private open: (url: string) => Promise<void>,
  ) {}
  async importJson(text: string) {
    const j = JSON.parse(text),
      cfg = j.installed;
    if (j.web) throw new Error('请使用 Desktop app 类型的 installed OAuth 配置');
    if (cfg?.client_id && cfg?.client_secret) {
      const c: Connection = {
        id: randomUUID(),
        clientId: cfg.client_id,
        projectId: cfg.project_id,
        clientSecret: cfg.client_secret,
        expiresAt: 0,
      };
      this.repo.saveConnection(c);
      return '客户端已导入，请点击授权并选择 Gmail 账号';
    }
    if (j.client_id && j.client_secret && j.refresh_token) {
      const c: Connection = {
        id: randomUUID(),
        clientId: j.client_id,
        projectId: j.project_id,
        clientSecret: j.client_secret,
        refreshToken: j.refresh_token,
        expiresAt: 0,
      };
      const verified = await this.refresh(c);
      await this.bind(verified);
      return '令牌已验证并安全导入';
    }
    throw new Error('无法识别：需要 installed credentials.json 或 authorized_user token.json');
  }
  async authorize(connectionId: string) {
    const template = this.repo.connections().find((c) => c.id === connectionId);
    if (!template) throw new Error('授权配置不存在');
    const c: Connection = {
      id: template.accountId ? randomUUID() : template.id,
      clientId: template.clientId,
      projectId: template.projectId,
      clientSecret: template.clientSecret,
      expiresAt: 0,
    };
    const verifier = randomBytes(48).toString('base64url'),
      state = randomBytes(32).toString('base64url');
    const server = createServer();
    let finish!: (code: string) => void, fail!: (e: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const redirect = `http://127.0.0.1:${port}/oauth/callback`;
    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', redirect);
      const actual = Buffer.from(url.searchParams.get('state') || ''),
        expected = Buffer.from(state);
      if (
        url.pathname !== '/oauth/callback' ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.writeHead(400);
        res.end('Invalid callback');
        return;
      }
      if (url.searchParams.get('error')) {
        res.end('Authorization cancelled. Return to the application.');
        fail(new Error('授权被取消或拒绝'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(
        '<title>授权完成</title><h2 style="font-family:system-ui;padding:48px">授权完成，请返回云盘工作台。</h2>',
      );
      finish(code);
    });
    const timer = setTimeout(() => fail(new Error('授权等待超时，请重试')), 180000);
    try {
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      await this.open(auth.toString());
      const code = await result;
      const tokens = await this.tokens({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      });
      c.accessToken = tokens.access_token;
      c.refreshToken = tokens.refresh_token;
      c.expiresAt = Date.now() + tokens.expires_in * 1000;
      if (!c.refreshToken) throw new Error('未收到离线令牌，请重新授权并确认同意访问');
      const a = await this.bind(c);
      return `已连接 ${a.email}`;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }
  private async tokens(
    body: Record<string, string>,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(25000),
    });
    const data = (await res.json()) as {
      error?: string;
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!res.ok)
      throw new OperationError(
        `授权令牌请求失败：${data.error || res.status}${res.status < 500 && res.status !== 429 ? '，请重新授权' : '，请稍后重试'}`,
        res.status >= 500 ? 503 : res.status === 429 ? 429 : 401,
      );
    return data;
  }
  private async identity(token: string, connection?: Connection) {
    const ticket = connection?.accountId
      ? {
          account: this.limits.bucket(
            'a:' + connection.accountId,
            this.accountCeiling(connection.accountId),
          ).epoch,
          connection: this.limits.bucket(
            'c:' + connection.id,
            this.repo.settings().connectionConcurrency,
          ).epoch,
          project: this.limits.bucket(
            'p:' + this.project(connection),
            this.projectCeiling(this.project(connection)),
          ).epoch,
        }
      : undefined;
    apiEvent({ type: 'request', method: 'GET' });
    if (connection?.accountId) this.recordRequest(connection.accountId);
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId,photoLink)',
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { errors?: { reason: string }[] };
      };
      const reason = data.error?.errors?.[0]?.reason || '';
      if (
        ticket &&
        connection &&
        (res.status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason))
      ) {
        const header = res.headers.get('retry-after');
        const wait = header
          ? /^\d+(?:\.\d+)?$/.test(header.trim())
            ? Number(header) * 1000
            : Date.parse(header) - Date.now()
          : 1000;
        this.rateLimit(
          connection,
          reason || 'userRateLimitExceeded',
          Math.max(1000, Number.isFinite(wait) ? wait : 1000),
          ticket,
        );
        apiEvent({ type: 'limit', message: '验证授权身份时被限流，已统一冷却' });
      }
      throw new OperationError(
        `无法验证账号身份（HTTP ${res.status}），${reason || '检查 Drive API 是否启用'}`,
        res.status,
        reason,
      );
    }
    const data = (await res.json()) as {
      user: { displayName: string; emailAddress: string; permissionId: string; photoLink?: string };
    };
    if (!data.user?.permissionId || !data.user.emailAddress)
      throw new Error('Google 未返回可验证身份');
    this.profiles.set(data.user.permissionId, data.user);
    return data.user;
  }
  private async bind(c: Connection) {
    const u = await this.identity(c.accessToken!, c);
    const id = u.permissionId;
    if (c.accountId && c.accountId !== id)
      throw new OperationError('授权身份与原账号不一致，连接已拒绝', 401);
    c.accountId = id;
    c.disabled = false;
    c.error = undefined;
    const duplicate = this.repo
      .connections()
      .find((x) => x.accountId === id && x.clientId === c.clientId && x.id !== c.id);
    if (duplicate) c.id = duplicate.id;
    this.repo.saveConnection(c);
    const account = {
      ...this.repo.accounts().find((a) => a.id === id),
      id,
      email: u.emailAddress,
      name: u.displayName || u.emailAddress.split('@')[0],
      permissionId: id,
      connections: 1,
      ready: true,
      photoLink: u.photoLink,
      avatarCheckedAt: undefined,
    };
    this.repo.saveAccount(account);
    return account;
  }
  async refreshProfile(accountId: string) {
    const before = this.profiles.get(accountId);
    const { connection, release } = await this.acquire(accountId);
    try {
      const recent = this.profiles.get(accountId);
      // Token refresh already verifies identity; reuse that response in this operation.
      const user =
        recent && recent !== before
          ? recent
          : await this.identity(connection.accessToken!, connection);
      if (user.permissionId !== accountId) throw new Error('授权身份不一致，不能更新头像');
      const old = this.repo.accounts().find((a) => a.id === accountId);
      if (!old) throw new Error('账号不存在');
      const account = { ...old, name: user.displayName || old.name, photoLink: user.photoLink };
      this.repo.saveAccount(account);
      return account;
    } finally {
      release();
    }
  }
  private async refresh(c: Connection) {
    let pending = this.refreshing.get(c.id);
    if (pending) return pending;
    pending = (async () => {
      if (!c.refreshToken) throw new OperationError('连接未授权，请先登录', 401);
      try {
        const d = await this.tokens({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: c.refreshToken,
          grant_type: 'refresh_token',
        });
        c.accessToken = d.access_token;
        c.expiresAt = Date.now() + d.expires_in * 1000;
        const identity = await this.identity(c.accessToken, c);
        if (c.accountId && identity.permissionId !== c.accountId)
          throw new OperationError('连接身份发生变化，禁止继续', 401);
        c.disabled = false;
        this.repo.saveConnection(c);
        return c;
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          c.disabled = true;
          c.error = '需要重新授权';
          this.repo.saveConnection(c);
        }
        throw e;
      }
    })();
    this.refreshing.set(c.id, pending);
    try {
      return await pending;
    } finally {
      this.refreshing.delete(c.id);
    }
  }
  private accountCeiling(accountId: string) {
    const s = this.repo.settings();
    const count = this.repo
      .connections()
      .filter(
        (c) => c.accountId === accountId && !c.disabled && (c.refreshToken || c.accessToken),
      ).length;
    return Math.max(1, Math.min(s.accountConcurrency, count * s.connectionConcurrency));
  }
  private project(c: Connection) {
    // Old encrypted profiles may not contain project_id. Group them conservatively
    // rather than pretend different client IDs imply independent project quotas.
    return (
      c.projectId ||
      this.repo.connections().find((x) => x.clientId === c.clientId && x.projectId)?.projectId ||
      'unidentified'
    );
  }
  private projectCeiling(project: string) {
    const s = this.repo.settings(),
      perAccount = new Map<string, number>();
    for (const c of this.repo.connections())
      if (c.accountId && !c.disabled && this.project(c) === project)
        perAccount.set(c.accountId, (perAccount.get(c.accountId) || 0) + s.connectionConcurrency);
    return Math.max(
      1,
      [...perAccount.values()].reduce((total, n) => total + Math.min(s.accountConcurrency, n), 0),
    );
  }
  recordRequest(account: string) {
    const now = Date.now(),
      recent = (this.requests.get(account) || []).filter((t) => t > now - 60000);
    recent.push(now);
    this.requests.set(account, recent);
  }
  async acquire(
    accountId: string,
  ): Promise<{ connection: Connection; release: () => void; ticket: RateTicket }> {
    while (true) {
      checkRequestPause();
      const all = this.repo
        .connections()
        .filter(
          (c) => c.accountId === accountId && !c.disabled && (c.refreshToken || c.accessToken),
        );
      if (!all.length) throw new OperationError('该账号没有可用授权连接，请重新登录', 401);
      const s = this.repo.settings(),
        account = this.limits.bucket('a:' + accountId, this.accountCeiling(accountId));
      const accountCount = all.reduce((n, c) => n + (this.counts.get(c.id) || 0), 0);
      const available = all.filter((c) => {
        const project = this.project(c),
          connection = this.limits.bucket('c:' + c.id, s.connectionConcurrency),
          group = this.limits.bucket('p:' + project, this.projectCeiling(project));
        return (
          (this.counts.get(c.id) || 0) < connection.limit &&
          Date.now() >= connection.until &&
          Date.now() >= group.until &&
          (this.projectCounts.get(project) || 0) < group.limit
        );
      });
      if (accountCount < account.limit && Date.now() >= account.until && available.length) {
        let c = available[this.index++ % available.length];
        const project = this.project(c),
          group = this.limits.bucket('p:' + project, this.projectCeiling(project)),
          connection = this.limits.bucket('c:' + c.id, s.connectionConcurrency);
        const ticket = {
          account: account.epoch,
          connection: connection.epoch,
          project: group.epoch,
        };
        this.counts.set(c.id, (this.counts.get(c.id) || 0) + 1);
        this.projectCounts.set(project, (this.projectCounts.get(project) || 0) + 1);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.counts.set(c.id, Math.max(0, (this.counts.get(c.id) || 1) - 1));
          this.projectCounts.set(project, Math.max(0, (this.projectCounts.get(project) || 1) - 1));
        };
        try {
          if (!c.accessToken || c.expiresAt < Date.now() + 60000) c = await this.refresh(c);
          return { connection: c, release, ticket };
        } catch (e) {
          release();
          if (
            (e as { status?: number }).status === 401 &&
            this.repo
              .connections()
              .some((x) => x.accountId === accountId && x.id !== c.id && !x.disabled)
          )
            continue;
          throw e;
        }
      }
      await interruptibleWait(80);
    }
  }
  rateLimit(c: Connection, reason: string, waitMs: number, ticket: RateTicket) {
    const project = this.project(c);
    if (reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded')
      this.limits.reduce(
        'p:' + project,
        this.projectCeiling(project),
        ticket.project,
        waitMs,
        reason,
      );
    else
      this.limits.reduce(
        'a:' + c.accountId!,
        this.accountCeiling(c.accountId!),
        ticket.account,
        waitMs,
        reason,
      );
  }
  cooldown(id: string, ms: number) {
    const b = this.limits.bucket('c:' + id, this.repo.settings().connectionConcurrency);
    b.until = Math.max(b.until, Date.now() + ms);
  }
  snapshot(): RuntimeLimits {
    const connections = this.repo.connections().filter((c) => c.accountId && !c.disabled),
      s = this.repo.settings(),
      now = Date.now();
    const projects = [...new Set(connections.map((c) => this.project(c)))].map((project) => {
      const b = this.limits.bucket('p:' + project, this.projectCeiling(project));
      return {
        project,
        active: this.projectCounts.get(project) || 0,
        limit: b.limit,
        ceiling: b.ceiling,
        waitingMs: Math.max(0, b.until - now),
        reason: b.reason,
      };
    });
    return {
      projects,
      accounts: [...new Set(connections.map((c) => c.accountId!))].map((accountId) => {
        const own = connections.filter((c) => c.accountId === accountId),
          b = this.limits.bucket('a:' + accountId, this.accountCeiling(accountId));
        const groups = projects.filter((p) => own.some((c) => this.project(c) === p.project));
        const effective = Math.min(
          b.limit,
          own.reduce(
            (n, c) => n + this.limits.bucket('c:' + c.id, s.connectionConcurrency).limit,
            0,
          ),
          groups.reduce((n, p) => n + p.limit, 0),
        );
        const recent = (this.requests.get(accountId) || []).filter((t) => t > now - 60000);
        this.requests.set(accountId, recent);
        const constrained = groups.find((p) => p.waitingMs > 0 || p.limit < p.ceiling);
        return {
          accountId,
          active: own.reduce((n, c) => n + (this.counts.get(c.id) || 0), 0),
          limit: effective,
          ceiling: Math.min(s.accountConcurrency, own.length * s.connectionConcurrency),
          waitingMs: Math.max(0, b.until - now, ...groups.map((p) => p.waitingMs)),
          requestsPerMinute: recent.length,
          reason: b.limit < b.ceiling || b.until > now ? b.reason : constrained?.reason,
        };
      }),
    };
  }
  invalidate(id: string, disable = false, error = '需要重新验证授权') {
    const c = this.repo.connections().find((x) => x.id === id);
    if (c) {
      c.expiresAt = 0;
      c.accessToken = undefined;
      c.disabled = disable;
      c.error = error;
      this.repo.saveConnection(c);
    }
  }
}
