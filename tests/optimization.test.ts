import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveLimits } from '../core/limiter.js';
import { AuthService } from '../core/auth.js';
import { GoogleDrive } from '../core/drive.js';
import { MemoryStore } from '../core/store.js';
import { DemoDrive, DEMO_ACCOUNTS } from '../core/demo.js';
import { TaskEngine, OperationError } from '../core/engine.js';
import { normalizeSettings } from '../core/types.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pool(accounts = ['a', 'a', 'a'], projects = accounts.map(() => 'p')) {
  const repo = new MemoryStore();
  accounts.forEach((accountId, index) =>
    repo.saveConnection({
      id: `c${index}`,
      accountId,
      projectId: projects[index],
      clientId: `client${index}`,
      clientSecret: 'test',
      accessToken: `token${index}`,
      expiresAt: Date.now() + 3600000,
    }),
  );
  return { repo, auth: new AuthService(repo, async () => {}) };
}
describe('无全局业务上限与统一限流', () => {
  it('默认 18/6，旧全局字段不再生效，旧过大配置被限制', () => {
    expect(normalizeSettings()).toEqual({ accountConcurrency: 18, connectionConcurrency: 6 });
    expect(
      normalizeSettings({ concurrency: 1, accountConcurrency: 128, connectionConcurrency: 64 }),
    ).toEqual(normalizeSettings());
  });
  it('同轮 18 个错误只减半一次，稳定 60 秒后逐级恢复', () => {
    let now = 0;
    const limits = new AdaptiveLimits(() => now);
    const b = limits.bucket('a', 18);
    for (let n = 0; n < 18; n++) limits.reduce('a', 18, 0, 2000, 'userRateLimitExceeded');
    expect(b.limit).toBe(9);
    now = 61999;
    expect(limits.bucket('a', 18).limit).toBe(9);
    now = 62000;
    expect(limits.bucket('a', 18).limit).toBe(18);
    for (const expected of [9, 4, 2, 1, 1]) {
      const epoch = b.epoch;
      limits.reduce('a', 18, epoch, 1000, 'limit');
      expect(b.limit).toBe(expected);
    }
    now += 61000;
    expect(limits.bucket('a', 18).limit).toBe(2);
    now += 60000;
    expect(limits.bucket('a', 18).limit).toBe(4);
  });
  it('3 连接立即达到 18，单连接立即达到 6，不设起始爬升', async () => {
    const { auth } = pool();
    const held = await Promise.all(Array.from({ length: 18 }, () => auth.acquire('a')));
    expect(auth.snapshot().accounts[0]).toMatchObject({ active: 18, limit: 18, ceiling: 18 });
    held.forEach((x) => x.release());
    const one = pool(['a']).auth;
    const six = await Promise.all(Array.from({ length: 6 }, () => one.acquire('a')));
    expect(one.snapshot().accounts[0]).toMatchObject({ active: 6, limit: 6 });
    six.forEach((x) => x.release());
  });
  it('旧 global=1 不限制不同账号或同账号的网络请求', async () => {
    const { repo, auth } = pool(['a', 'b']);
    repo.saveSettings({ concurrency: 1, accountConcurrency: 18, connectionConcurrency: 6 });
    const held = await Promise.all([auth.acquire('a'), auth.acquire('b')]);
    expect(auth.snapshot().accounts.map((a) => a.active)).toEqual([1, 1]);
    held.forEach((x) => x.release());
  });
  it('账号限流统一冷却全部连接，同一轮不连续减半，其他账号继续', async () => {
    vi.useFakeTimers();
    const { auth } = pool(['a', 'a', 'a', 'b']);
    const first = await auth.acquire('a'),
      second = await auth.acquire('a');
    auth.rateLimit(first.connection, 'userRateLimitExceeded', 2000, first.ticket);
    auth.rateLimit(second.connection, 'userRateLimitExceeded', 2000, second.ticket);
    first.release();
    second.release();
    expect(auth.snapshot().accounts.find((a) => a.accountId === 'a')?.limit).toBe(9);
    let acquired = false;
    const queued = auth.acquire('a').then((x) => {
      acquired = true;
      return x;
    });
    const other = await auth.acquire('b');
    other.release();
    await vi.advanceTimersByTimeAsync(1999);
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(81);
    (await queued).release();
    expect(acquired).toBe(true);
  });
  it('单连接限流有效上限从 6 降为 3', async () => {
    const { auth } = pool(['a']);
    const r = await auth.acquire('a');
    auth.rateLimit(r.connection, 'userRateLimitExceeded', 1000, r.ticket);
    r.release();
    expect(auth.snapshot().accounts[0].limit).toBe(3);
  });
  it('项目限流跨账号共享冷却，不影响已识别的其他项目', async () => {
    const { auth } = pool(['a', 'b', 'c'], ['same', 'same', 'other']);
    const r = await auth.acquire('a');
    auth.rateLimit(r.connection, 'rateLimitExceeded', 5000, r.ticket);
    r.release();
    const snap = auth.snapshot();
    expect(snap.accounts.find((a) => a.accountId === 'b')?.waitingMs).toBeGreaterThan(0);
    expect(snap.accounts.find((a) => a.accountId === 'c')?.waitingMs).toBe(0);
  });
  it('服务端 Retry-After 必须跨连接等待，不能轮换绕过', async () => {
    vi.useFakeTimers();
    const { auth } = pool(['a', 'a']);
    const drive = new GoogleDrive(auth);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++calls === 1
          ? new Response(
              JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
              { status: 403, headers: { 'Retry-After': '5' } },
            )
          : Response.json({ id: 'f', parents: [] }),
      ),
    );
    const result = drive.get('a', 'f');
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(calls).toBe(2);
  });
  it('共享限额不快速重复写入，保留明确原因与长冷却', async () => {
    const { auth } = pool(['a', 'a']);
    const drive = new GoogleDrive(auth);
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { errors: [{ reason: 'sharingRateLimitExceeded' }] } },
        { status: 403 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      drive.createPermission('a', 'f', {
        role: 'writer',
        type: 'user',
        emailAddress: 'test@example.com',
      }),
    ).rejects.toMatchObject({ status: 403, reason: 'sharingRateLimitExceeded' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.snapshot().accounts[0].waitingMs).toBeGreaterThan(59000);
  });
});

function transferSetup() {
  const repo = new MemoryStore(),
    drive = new DemoDrive();
  vi.spyOn(drive as any, 'wait').mockResolvedValue(undefined);
  for (const a of DEMO_ACCOUNTS) {
    repo.saveAccount(a);
    repo.saveConnection({
      id: a.id,
      accountId: a.id,
      clientId: 'test',
      clientSecret: 'test',
      expiresAt: 0,
    });
  }
  return { repo, drive, engine: new TaskEngine(repo, drive, { propagationDelays: [0, 0, 0] }) };
}
async function settle(repo: MemoryStore, id: string) {
  for (let n = 0; n < 500; n++) {
    const t = repo.tasks().find((t) => t.id === id)!;
    if (['completed', 'partial', 'paused'].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw Error('not settled');
}
const req = {
  kind: 'transfer' as const,
  accountId: 'demo-lin',
  targetAccountId: 'demo-work',
  ids: ['brief'],
  recursive: false,
};
describe('转让分阶段恢复与请求复用', () => {
  it('直接利用邀请返回的权限 ID 接收，正常执行无需目标权限列表', async () => {
    const { repo, drive, engine } = transferSetup();
    const p = await engine.preview(req),
      get = vi.spyOn(drive, 'get'),
      permissions = vi.spyOn(drive, 'permissions');
    const result = await settle(repo, engine.submit(p.id).id);
    expect(result.status).toBe('completed');
    expect(get).toHaveBeenCalledTimes(2);
    expect(permissions).toHaveBeenCalledTimes(1);
    expect(result.items[0].transferStage).toBe('verified');
  });
  it('接收时发生短暂权限同步延迟，自动复查当前步骤且不重复邀请', async () => {
    const { repo, drive, engine } = transferSetup();
    const p = await engine.preview(req);
    const accept = drive.updatePermission.bind(drive),
      ps = drive.permissions.bind(drive);
    let rejected = false,
      hidden = true;
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      if (args[4] && !rejected) {
        rejected = true;
        throw new OperationError('传播尚未完成', 403, 'insufficientFilePermissions');
      }
      return accept(...args);
    });
    vi.spyOn(drive, 'permissions').mockImplementation(async (a, id) => {
      const values = await ps(a, id);
      if (a === 'demo-work' && hidden) {
        hidden = false;
        return [];
      }
      return values;
    });
    const invite = vi.spyOn(drive, 'createPermission');
    const result = await settle(repo, engine.submit(p.id).id);
    expect(result.status).toBe('completed');
    expect(result.items[0].attempts).toBe(1);
    expect(invite).toHaveBeenCalledTimes(1);
    expect(result.items[0].history?.some((e) => e.kind === 'waiting')).toBe(true);
  });
  it('已接收但 GET 暂未反映所有权时只重读，不再次接收', async () => {
    const { repo, drive, engine } = transferSetup();
    const p = await engine.preview(req),
      get = drive.get.bind(drive);
    let first = true;
    vi.spyOn(drive, 'get').mockImplementation(async (a, id) => {
      const f = await get(a, id);
      if (a === 'demo-work' && first) {
        first = false;
        return { ...f, ownedByMe: false };
      }
      return f;
    });
    const accept = vi.spyOn(drive, 'updatePermission');
    const result = await settle(repo, engine.submit(p.id).id);
    expect(result.status).toBe('completed');
    expect(accept.mock.calls.filter((c) => c[4])).toHaveLength(1);
  });
  it('写入前即丢失邀请响应时持久化阶段，恢复不盲目重复邀请', async () => {
    const { repo, drive, engine } = transferSetup();
    const p = await engine.preview(req);
    const invite = vi
      .spyOn(drive, 'createPermission')
      .mockRejectedValue(new OperationError('未知写入', 503));
    const task = engine.submit(p.id);
    expect((await settle(repo, task.id)).status).toBe('paused');
    expect(repo.tasks()[0].items[0].transferStage).toBe('inviting');
    const restored = new TaskEngine(repo, drive, { propagationDelays: [0] });
    await restored.control(task.id, 'retry');
    expect((await settle(repo, task.id)).status).toBe('paused');
    expect(invite).toHaveBeenCalledTimes(1);
    expect(repo.tasks()[0].items[0].history?.some((e) => e.kind === 'paused')).toBe(true);
  });
  it('递归选择父目录和深层子目录只扫描父目录一次', async () => {
    const { drive, engine } = transferSetup();
    const list = vi.spyOn(drive, 'list');
    await engine.preview({ ...req, ids: ['projects', 'design-a'], recursive: true });
    expect(list.mock.calls.map((c) => c[1])).toEqual(['projects']);
  });
  it('邀请已写入但回包丢失，恢复对账后不重复邀请', async () => {
    const { repo, drive, engine } = transferSetup();
    const p = await engine.preview(req),
      create = drive.createPermission.bind(drive);
    let first = true;
    const invite = vi.spyOn(drive, 'createPermission').mockImplementation(async (...args) => {
      const p = await create(...args);
      if (first) {
        first = false;
        throw new OperationError('回包丢失', 503);
      }
      return p;
    });
    const task = engine.submit(p.id);
    expect((await settle(repo, task.id)).status).toBe('paused');
    const restored = new TaskEngine(repo, drive, { propagationDelays: [0] });
    await restored.control(task.id, 'retry');
    expect((await settle(repo, task.id)).status).toBe('completed');
    expect(invite).toHaveBeenCalledTimes(1);
  });
  it('等待同步时可暂停，恢复后不重复接收', async () => {
    const { repo, drive } = transferSetup(),
      engine = new TaskEngine(repo, drive, { propagationDelays: [5000] });
    const p = await engine.preview(req),
      get = drive.get.bind(drive);
    let hidden = true;
    vi.spyOn(drive, 'get').mockImplementation(async (a, id) => {
      const f = await get(a, id);
      if (a === 'demo-work' && hidden) {
        hidden = false;
        return { ...f, ownedByMe: false };
      }
      return f;
    });
    const accept = vi.spyOn(drive, 'updatePermission');
    const task = engine.submit(p.id);
    await vi.waitFor(() =>
      expect(repo.tasks()[0].items[0].history?.some((e) => e.kind === 'waiting')).toBe(true),
    );
    await engine.control(task.id, 'pause');
    await vi.waitFor(() => expect(repo.tasks()[0].items[0].state).toBe('queued'));
    const restored = new TaskEngine(repo, drive, { propagationDelays: [0] });
    await restored.control(task.id, 'retry');
    expect((await settle(repo, task.id)).status).toBe('completed');
    expect(accept.mock.calls.filter((c) => c[4])).toHaveLength(1);
  });
  it('一个账号等待网络时，另一个账号的新任务仍可完成', async () => {
    const { repo, drive, engine } = transferSetup();
    let release!: () => void,
      started = false;
    const waiting = new Promise<void>((resolve) => (release = resolve)),
      update = drive.update.bind(drive);
    vi.spyOn(drive, 'update').mockImplementation(async (...args) => {
      if (args[0] === 'demo-lin') {
        started = true;
        await waiting;
      }
      return update(...args);
    });
    const slow = await engine.preview({
      kind: 'rename',
      accountId: 'demo-lin',
      ids: ['brief'],
      recursive: false,
      name: 'slow',
    });
    const fast = await engine.preview({
      kind: 'rename',
      accountId: 'demo-work',
      ids: ['budget'],
      recursive: false,
      name: 'fast',
    });
    const slowTask = engine.submit(slow.id);
    await vi.waitFor(() => expect(started).toBe(true));
    try {
      const fastTask = engine.submit(fast.id);
      expect((await settle(repo, fastTask.id)).status).toBe('completed');
    } finally {
      release();
    }
    expect((await settle(repo, slowTask.id)).status).toBe('completed');
  });
});
