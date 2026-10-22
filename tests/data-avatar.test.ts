import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore } from '../core/store.js';
import { TaskEngine } from '../core/engine.js';
import { DemoDrive, DEMO_ACCOUNTS } from '../core/demo.js';
import { AvatarCache, downloadAvatar } from '../core/avatars.js';
import { AuthService } from '../core/auth.js';
import { DEFAULT_SETTINGS, type Task } from '../core/types.js';

afterEach(() => vi.unstubAllGlobals());
const account = { ...DEMO_ACCOUNTS[0], photoLink: 'https://lh3.googleusercontent.com/photo' };
function seed(store: MemoryStore, value: (typeof DEMO_ACCOUNTS)[number] = account) {
  store.saveAccount(value);
  store.saveConnection({
    id: value.id,
    accountId: value.id,
    clientId: 'c',
    clientSecret: 's',
    accessToken: 'test',
    expiresAt: Date.now() + 3600000,
  });
}
const task = (id: string): Task => ({
  id,
  title: 'test',
  request: { accountId: account.id, ids: ['f'], kind: 'rename', name: 'new', recursive: false },
  createdAt: '2026-10-22',
  updatedAt: '2026-10-22',
  status: 'completed',
  paused: false,
  items: [
    {
      file: { id: 'f', name: 'file', parents: [], mimeType: 'text/plain' },
      mutations: [],
      changes: [],
      state: 'succeeded',
      attempts: 1,
      history: [{ time: 'now', kind: 'test', message: 'log' }],
      api: { reads: 1, writes: 1, retries: 0, rateLimits: 0 },
    },
  ],
});

describe('本地数据清理', () => {
  for (const type of ['memory', 'sqlite'])
    it(`${type}: 任务、账号和重置保持正确范围`, () => {
      const store =
        type === 'memory'
          ? new MemoryStore()
          : new SqliteStore(
              ':memory:',
              (s) => s,
              (s) => s,
            );
      store.saveAccount(account);
      store.saveAccount(DEMO_ACCOUNTS[1]);
      for (const a of DEMO_ACCOUNTS)
        store.saveConnection({
          id: a.id,
          accountId: a.id,
          clientId: 'c',
          clientSecret: 's',
          expiresAt: 0,
        });
      store.saveTask(task('a'));
      store.saveTask(task('b'));
      store.deleteTasks(['a']);
      expect(store.tasks().map((t) => t.id)).toEqual(['b']);
      expect(store.accounts()).toHaveLength(2);
      store.deleteAccount(account.id);
      expect(store.accounts().map((a) => a.id)).toEqual([DEMO_ACCOUNTS[1].id]);
      expect(store.connections().map((c) => c.accountId)).toEqual([DEMO_ACCOUNTS[1].id]);
      expect(store.tasks()).toHaveLength(1);
      store.saveSettings({ accountConcurrency: 2, connectionConcurrency: 1 });
      store.reset();
      expect(store.tasks()).toEqual([]);
      expect(store.accounts()).toEqual([]);
      expect(store.connections()).toEqual([]);
      expect(store.settings()).toEqual(DEFAULT_SETTINGS);
      if (store instanceof SqliteStore) store.close();
    });
  it('SQLite 删除任务头、状态、明细与日志，重启后不恢复', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'drive-clean-')), 'db.sqlite');
    const store = new SqliteStore(
      path,
      (s) => s,
      (s) => s,
    );
    store.saveTask(task('a'));
    store.saveTask(task('b'));
    store.deleteTasks(['a']);
    store.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM records WHERE id='a'").get()!.n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_items WHERE task_id='a'").get()!.n).toBe(0);
    raw.close();
    const reopened = new SqliteStore(
      path,
      (s) => s,
      (s) => s,
    );
    expect(reopened.tasks().map((t) => t.id)).toEqual(['b']);
    reopened.close();
  });
  it('批量删除先核验整批，不会先删已完成项再因运行项失败', () => {
    const store = new MemoryStore(),
      engine = new TaskEngine(store, new DemoDrive());
    store.saveTask(task('done'));
    store.saveTask({ ...task('running'), status: 'running' });
    expect(() => engine.deleteTasks(['done', 'running'])).toThrow('仍在执行');
    expect(store.tasks()).toHaveLength(2);
    expect(() => engine.deleteTasks(['done', 'missing'])).toThrow('不存在');
    expect(store.tasks()).toHaveLength(2);
  });
  it('SQLite 删除失败时整批回滚，任务头和明细不会残缺', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'drive-clean-rollback-')), 'db.sqlite');
    const store = new SqliteStore(
      path,
      (s) => s,
      (s) => s,
    );
    store.saveTask(task('a'));
    store.saveTask(task('b'));
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER block_delete BEFORE DELETE ON task_items WHEN old.task_id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    expect(() => store.deleteTasks(['a', 'b'])).toThrow('fixture failure');
    expect(store.tasks()).toHaveLength(2);
    expect(store.tasks().every((t) => t.items.length === 1)).toBe(true);
    raw.close();
    store.close();
  });
  it('暂停后仍有在途写入时阻止删除和重置，结束后可删除且不会重建记录', async () => {
    const store = new MemoryStore();
    seed(store);
    const drive = new DemoDrive();
    let finish!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const wait = new Promise<void>((r) => (finish = r));
    vi.spyOn(drive, 'update').mockImplementation(async (_a, id) => {
      started();
      await wait;
      return drive.get(account.id, id);
    });
    const engine = new TaskEngine(store, drive);
    const plan = await engine.preview({
      accountId: account.id,
      ids: ['brief'],
      kind: 'rename',
      name: 'new',
      recursive: false,
    });
    const t = engine.submit(plan.id);
    await began;
    await engine.control(t.id, 'pause');
    expect(() => engine.deleteTasks([t.id])).toThrow('仍在执行');
    expect(() => engine.reset()).toThrow('在途');
    finish();
    await vi.waitFor(() => expect(engine.maintenanceBusy).toBe(false));
    expect(engine.deleteTasks([t.id])).toBe(1);
    expect(store.tasks()).toEqual([]);
  });
});

describe('真实头像与缓存', () => {
  it('刷新过期令牌时复用身份校验，不重复读取 about', async () => {
    const store = new MemoryStore();
    seed(store);
    const c = store.connections()[0];
    store.saveConnection({ ...c, expiresAt: 0, refreshToken: 'refresh' });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('oauth2'))
        return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }));
      return new Response(
        JSON.stringify({
          user: {
            displayName: 'Name',
            emailAddress: account.email,
            permissionId: account.id,
            photoLink: account.photoLink,
          },
        }),
      );
    });
    await new AuthService(store, async () => {}).refreshProfile(account.id);
    expect(urls.filter((url) => url.includes('/about'))).toHaveLength(1);
    expect(urls).toHaveLength(2);
  });
  it('复用身份请求获取 photoLink，旧账号资料刷新不增加授权范围', async () => {
    const store = new MemoryStore();
    store.saveAccount(account);
    store.saveConnection({
      id: 'c',
      accountId: account.id,
      clientId: 'c',
      clientSecret: 's',
      accessToken: 'secret',
      expiresAt: Date.now() + 3600000,
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              displayName: 'Name',
              emailAddress: account.email,
              permissionId: account.id,
              photoLink: account.photoLink,
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    await new AuthService(store, async () => {}).refreshProfile(account.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('photoLink');
    expect(store.accounts()[0].photoLink).toBe(account.photoLink);
  });
  it('新头像仅下载一次，并发请求合并，持久化缓存一天内不读身份或图片', async () => {
    const store = new MemoryStore();
    seed(store);
    const profile = vi.fn(async () => account),
      convert = vi.fn(() => 'data:image/png;base64,cache');
    const fetcher = vi.fn(
      async () => new Response('png', { headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const cache = new AvatarCache(store, profile, convert);
    await Promise.all([cache.refresh(account.id), cache.refresh(account.id)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(profile).not.toHaveBeenCalled();
    await new AvatarCache(store, profile, convert).refresh(account.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.accounts()[0].avatar).toContain('data:image/png');
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');
  });
  it('旧账号首次补查、手动刷新重新读取身份，过期缓存失败时保留原头像', async () => {
    const store = new MemoryStore();
    seed(store, { ...account, photoLink: undefined });
    const profile = vi.fn(async () => account);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png' } })),
    );
    const cache = new AvatarCache(store, profile, () => 'cached-photo');
    await cache.refresh(account.id);
    expect(profile).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('offline');
      }),
    );
    expect(await cache.refresh(account.id, true)).toBe('unavailable');
    expect(profile).toHaveBeenCalledTimes(2);
    expect(store.accounts()[0].avatar).toBe('cached-photo');
  });
  it('没有照片则使用首字母，授权失效或网络失败不影响账号列表', async () => {
    const store = new MemoryStore();
    seed(store, { ...account, photoLink: undefined });
    const cache = new AvatarCache(
      store,
      async () => ({ ...account, photoLink: undefined }),
      () => 'never',
    );
    expect(await cache.refresh(account.id)).toBe('unavailable');
    expect(store.accounts()).toHaveLength(1);
    expect(store.accounts()[0].avatar).toBeUndefined();
  });
  it('缓存过期后重新查询资料以获取新的头像地址', async () => {
    const store = new MemoryStore();
    seed(store, { ...account, avatarCheckedAt: 1 });
    const profile = vi.fn(async () => ({
      ...account,
      photoLink: 'https://lh3.googleusercontent.com/new',
    }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response('png', { headers: { 'content-type': 'image/png' } });
    });
    await new AvatarCache(store, profile, () => 'new-cache').refresh(account.id);
    expect(profile).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(['https://lh3.googleusercontent.com/new']);
  });
  it('阻止非 Google 地址、不安全重定向、SVG 和过大图片', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(downloadAvatar('http://lh3.googleusercontent.com/a')).rejects.toThrow();
    await expect(downloadAvatar('https://googleusercontent.com.evil.test/a')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a' } }),
    );
    await expect(downloadAvatar(account.photoLink!)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    );
    await expect(downloadAvatar(account.photoLink!)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array(512 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    );
    await expect(downloadAvatar(account.photoLink!)).rejects.toThrow('过大');
  });
});
