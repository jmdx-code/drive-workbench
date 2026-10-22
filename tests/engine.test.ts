import { describe, it, expect, vi } from 'vitest';
import { MemoryStore, SqliteStore } from '../core/store.js';
import { TaskEngine, OperationError } from '../core/engine.js';
import { DemoDrive, DEMO_ACCOUNTS } from '../core/demo.js';
import { DEFAULT_SHARE, FOLDER, type ActionRequest, type Task } from '../core/types.js';
import { planPermissions, matchesOwner, ownershipOf } from '../core/permissions.js';
import { snapshotHtml } from '../core/snapshot.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const repo = new MemoryStore();
  for (const a of DEMO_ACCOUNTS) {
    repo.saveAccount(a);
    repo.saveConnection({
      id: a.id,
      accountId: a.id,
      clientId: 'same-client',
      clientSecret: 'test',
      refreshToken: 'test',
      expiresAt: 0,
    });
  }
  const drive = new DemoDrive();
  vi.spyOn(drive as any, 'wait').mockResolvedValue(undefined);
  const engine = new TaskEngine(repo, drive);
  return { repo, drive, engine };
}
const request = (r: Partial<ActionRequest>): ActionRequest => ({
  accountId: 'demo-lin',
  kind: 'share',
  ids: ['brief'],
  recursive: false,
  share: { ...DEFAULT_SHARE },
  ...r,
});
async function settled(repo: MemoryStore, id: string) {
  for (let n = 0; n < 300; n++) {
    const t = repo.tasks().find((t) => t.id === id)!;
    if (['completed', 'partial', 'paused'].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('task did not settle');
}
describe('权限规划安全', () => {
  it('所有者筛选区分本人、他人与未知，不把缺失信息当作本人', () => {
    const base = { id: 'f', name: 'f', parents: [], mimeType: 'text/plain' };
    expect(ownershipOf(base, DEMO_ACCOUNTS[0])).toBe('unknown');
    expect(matchesOwner(base, 'mine', DEMO_ACCOUNTS[0])).toBe(false);
    expect(
      ownershipOf(
        { ...base, owners: [{ emailAddress: DEMO_ACCOUNTS[0].email.toUpperCase() }] },
        DEMO_ACCOUNTS[0],
      ),
    ).toBe('mine');
    expect(
      ownershipOf(
        { ...base, ownedByMe: false, owners: [{ emailAddress: DEMO_ACCOUNTS[0].email }] },
        DEMO_ACCOUNTS[0],
      ),
    ).toBe('others');
  });
  it('批量修改角色只更新已有邮箱，不新增缺失邮箱且保护所有者', () => {
    const ops = planPermissions(
      [
        { id: 'a', type: 'user', role: 'writer', emailAddress: 'a@test.com' },
        { id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@test.com' },
      ],
      {
        ...DEFAULT_SHARE,
        collaborators: 'update',
        people: [
          { type: 'user', email: 'a@test.com', role: 'reader' },
          { type: 'user', email: 'missing@test.com', role: 'writer' },
          { type: 'user', email: 'owner@test.com', role: 'reader' },
        ],
      },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'update', id: 'a', permission: { role: 'reader' } });
  });
  it('批量移除指定邮箱保留其他邮箱和公开链接', () => {
    const ops = planPermissions(
      [
        { id: 'a', type: 'user', role: 'writer', emailAddress: 'a@test.com' },
        { id: 'b', type: 'user', role: 'reader', emailAddress: 'b@test.com' },
        { id: 'c', type: 'user', role: 'writer', emailAddress: 'c@test.com' },
        { id: 'public', type: 'anyone', role: 'reader' },
      ],
      {
        ...DEFAULT_SHARE,
        collaborators: 'remove',
        people: [
          { type: 'user', email: 'A@test.com', role: 'reader' },
          { type: 'user', email: 'b@test.com', role: 'reader' },
        ],
      },
    );
    expect(ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect(ops.every((o) => o.kind === 'delete')).toBe(true);
  });
  it('替换将新增排在删除前，且保护owner', () => {
    const ops = planPermissions(
      [
        { id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@test.com' },
        { id: 'old', type: 'user', role: 'writer', emailAddress: 'old@test.com' },
      ],
      {
        ...DEFAULT_SHARE,
        collaborators: 'replace',
        people: [{ type: 'user', email: 'new@test.com', role: 'writer' }],
      },
    );
    expect(ops.map((o) => o.kind)).toEqual(['create', 'delete']);
    expect(ops[1].id).toBe('old');
  });
  it('精确模式降级，至少模式保留高权限', () => {
    const ps = [
      { id: 'a', type: 'user' as const, role: 'writer' as const, emailAddress: 'a@test.com' },
    ];
    const cfg = {
      ...DEFAULT_SHARE,
      collaborators: 'add' as const,
      people: [{ email: 'a@test.com', type: 'user' as const, role: 'reader' as const }],
    };
    expect(planPermissions(ps, cfg)[0].kind).toBe('update');
    expect(planPermissions(ps, { ...cfg, atLeast: true })).toHaveLength(0);
  });
  it('拒绝删除继承权限，不扩大到父目录', () => {
    expect(() =>
      planPermissions(
        [{ id: 'p', type: 'anyone', role: 'reader', permissionDetails: [{ inherited: true }] }],
        { ...DEFAULT_SHARE, public: 'off' },
      ),
    ).toThrow('继承权限');
  });
});
describe('任务闭环', () => {
  it('预览后撤销重命名权限，执行前阻止且不发送写请求', async () => {
    const { repo, drive, engine } = setup();
    const plan = await engine.preview(request({ kind: 'rename', name: '新名称' }));
    drive.files.find((f) => f.id === 'brief')!.capabilities!.canRename = false;
    const update = vi.spyOn(drive, 'update');
    const task = engine.submit(plan.id);
    const done = await settled(repo, task.id);
    expect(done.status).toBe('partial');
    expect(done.items[0].error).toContain('无权重命名');
    expect(update).not.toHaveBeenCalled();
  });
  it('复制预览后所有者改变，不继续处理筛选外文件', async () => {
    const { repo, drive, engine } = setup();
    const plan = await engine.preview(
      request({ kind: 'copy', ownerFilter: 'mine', destination: 'root' }),
    );
    drive.files.find((f) => f.id === 'brief')!.owners = [{ permissionId: 'demo-work' }];
    const copy = vi.spyOn(drive, 'copy');
    const task = engine.submit(plan.id);
    const done = await settled(repo, task.id);
    expect(done.status).toBe('partial');
    expect(done.items[0].error).toContain('不符合筛选范围');
    expect(copy).not.toHaveBeenCalled();
  });
  it('仅本人拥有的递归权限任务排除他人文件，不读取或修改其权限', async () => {
    const { repo, drive, engine } = setup();
    const other = drive.files.find((f) => f.id === 'wireframes')!;
    other.owners = [{ permissionId: 'demo-work', emailAddress: DEMO_ACCOUNTS[1].email }];
    const read = vi.spyOn(drive, 'permissions');
    const create = vi.spyOn(drive, 'createPermission');
    const plan = await engine.preview(
      request({
        ids: ['projects'],
        recursive: true,
        ownerFilter: 'mine',
        share: {
          ...DEFAULT_SHARE,
          collaborators: 'add',
          people: [{ type: 'user', email: 'new@test.com', role: 'reader' }],
        },
      }),
    );
    expect(plan.items.some((i) => i.file.id === 'wireframes')).toBe(false);
    expect(plan.warnings.join(' ')).toContain('排除 1 项');
    expect(read.mock.calls.some((c) => c[1] === 'wireframes')).toBe(false);
    const task = engine.submit(plan.id);
    expect((await settled(repo, task.id)).status).toBe('completed');
    expect(create.mock.calls.some((c) => c[1] === 'wireframes')).toBe(false);
  });
  it('转让发起后暂停不会继续接收，恢复后不重复邀请', async () => {
    const { repo, drive, engine } = setup();
    const original = drive.createPermission.bind(drive);
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const invite = vi.spyOn(drive, 'createPermission').mockImplementation(async (...args) => {
      const result = await original(...args);
      entered();
      await gate;
      return result;
    });
    const accept = vi.spyOn(drive, 'updatePermission');
    const p = await engine.preview(request({ kind: 'transfer', targetAccountId: 'demo-work' }));
    const t = engine.submit(p.id);
    await start;
    await engine.control(t.id, 'pause');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(accept).not.toHaveBeenCalled();
    expect(repo.tasks()[0].items[0].state).toBe('queued');
    await engine.control(t.id, 'resume');
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect(invite).toHaveBeenCalledTimes(1);
  });
  it('不同文件确实并行，同一文件跨任务仍互斥', async () => {
    const { repo, drive, engine } = setup();
    repo.saveSettings({ concurrency: 8, accountConcurrency: 8, connectionConcurrency: 8 });
    let active = 0,
      max = 0;
    const perFile = new Map<string, number>();
    const collisions: string[] = [];
    const original = drive.update.bind(drive);
    vi.spyOn(drive, 'update').mockImplementation(async (...args) => {
      active++;
      max = Math.max(max, active);
      const id = args[1];
      perFile.set(id, (perFile.get(id) || 0) + 1);
      if (perFile.get(id)! > 1) collisions.push(id);
      await new Promise((r) => setTimeout(r, 25));
      try {
        return await original(...args);
      } finally {
        active--;
        perFile.set(id, perFile.get(id)! - 1);
      }
    });
    const p1 = await engine.preview(request({ kind: 'trash', ids: ['brief', 'budget'] }));
    const p2 = await engine.preview(request({ kind: 'trash', ids: ['brief', 'guide'] }));
    const t1 = engine.submit(p1.id),
      t2 = engine.submit(p2.id);
    await settled(repo, t1.id);
    await settled(repo, t2.id);
    expect(max).toBeGreaterThan(1);
    expect(collisions).toEqual([]);
  });
  it('同client多个账号仍分别保留连接', () => {
    const { repo } = setup();
    expect(repo.accounts()).toHaveLength(2);
    expect(repo.connections().map((c) => c.accountId)).toEqual(['demo-lin', 'demo-work']);
  });
  it('权限替换新增失败时不撤销旧权限', async () => {
    const { repo, drive, engine } = setup();
    drive.files
      .find((f) => f.id === 'brief')!
      .permissions!.push({ id: 'old', type: 'user', role: 'writer', emailAddress: 'old@test.com' });
    vi.spyOn(drive, 'createPermission').mockRejectedValue(new OperationError('配额失败', 429));
    const del = vi.spyOn(drive, 'deletePermission');
    const p = await engine.preview(
      request({
        share: {
          ...DEFAULT_SHARE,
          collaborators: 'replace',
          people: [{ email: 'new@test.com', type: 'user', role: 'writer' }],
        },
      }),
    );
    const t = engine.submit(p.id);
    expect((await settled(repo, t.id)).status).toBe('partial');
    expect(del).not.toHaveBeenCalled();
  });
  it('完整发起、接收和验证所有权，并保留源编辑者', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(request({ kind: 'transfer', targetAccountId: 'demo-work' }));
    const t = engine.submit(p.id);
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect((await drive.get('demo-work', 'brief')).ownedByMe).toBe(true);
    expect(
      (await drive.permissions('demo-work', 'brief')).find((p) => p.id === 'demo-lin')?.role,
    ).toBe('writer');
  });
  it('接收响应丢失后继续先确认所有权，不重复发起', async () => {
    const { repo, drive, engine } = setup();
    const original = drive.updatePermission.bind(drive);
    let once = true;
    const update = vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[4] && once) {
        once = false;
        throw new OperationError('响应丢失', 503);
      }
      return result;
    });
    const create = vi.spyOn(drive, 'createPermission');
    const p = await engine.preview(request({ kind: 'transfer', targetAccountId: 'demo-work' }));
    const t = engine.submit(p.id);
    expect((await settled(repo, t.id)).status).toBe('paused');
    await engine.control(t.id, 'retry');
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('扫描不完整时拒绝递归任务', async () => {
    const { drive, engine } = setup();
    vi.spyOn(drive, 'list').mockResolvedValue({
      files: [],
      complete: false,
      warnings: ['incompleteSearch'],
    });
    await expect(engine.preview(request({ ids: ['projects'], recursive: true }))).rejects.toThrow(
      '扫描不完整',
    );
  });
  it('预览后权限漂移会阻塞执行', async () => {
    const { repo, drive, engine } = setup();
    drive.files.find((f) => f.id === 'brief')!.permissions = drive.files
      .find((f) => f.id === 'brief')!
      .permissions!.filter((p) => p.type !== 'anyone');
    const p = await engine.preview(request({ share: { ...DEFAULT_SHARE, public: 'reader' } }));
    await drive.createPermission('demo-lin', 'brief', {
      type: 'user',
      role: 'reader',
      emailAddress: 'external@test.com',
    });
    const t = engine.submit(p.id);
    const result = await settled(repo, t.id);
    expect(result.items[0].error).toContain('预览后变化');
    expect((await drive.permissions('demo-lin', 'brief')).some((p) => p.type === 'anyone')).toBe(
      false,
    );
  });
  it('递归转让后代先于父目录', async () => {
    const { repo, drive, engine } = setup();
    const completed: string[] = [];
    const original = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[4]) completed.push(args[1]);
      return result;
    });
    const p = await engine.preview(
      request({
        kind: 'transfer',
        ids: ['projects'],
        recursive: true,
        targetAccountId: 'demo-work',
      }),
    );
    const t = engine.submit(p.id);
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect(completed.indexOf('plan')).toBeLessThan(completed.indexOf('design-a'));
    expect(completed.at(-1)).toBe('projects');
  });
  it('停止不领取下一批且恢复不重做完成项', async () => {
    const { repo, drive, engine } = setup();
    repo.saveSettings({ concurrency: 1, accountConcurrency: 1, connectionConcurrency: 1 });
    const original = drive.update.bind(drive);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const start = new Promise<void>((r) => (entered = r));
    const update = vi.spyOn(drive, 'update').mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const p = await engine.preview(request({ kind: 'trash', ids: ['brief', 'budget'] }));
    const t = engine.submit(p.id);
    await start;
    await engine.control(t.id, 'pause');
    release();
    await new Promise((r) => setTimeout(r, 25));
    expect(update).toHaveBeenCalledTimes(1);
    await engine.control(t.id, 'resume');
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect(update).toHaveBeenCalledTimes(2);
  });
  it('复制成功但响应丢失可用关联标记恢复', async () => {
    const { repo, drive, engine } = setup();
    const original = drive.copy.bind(drive);
    const copy = vi.spyOn(drive, 'copy').mockImplementation(async (...args) => {
      await original(...args);
      throw new OperationError('timeout', 503);
    });
    const p = await engine.preview(request({ kind: 'copy', destination: 'root' }));
    const t = engine.submit(p.id);
    await settled(repo, t.id);
    await engine.control(t.id, 'retry');
    expect((await settled(repo, t.id)).status).toBe('completed');
    expect(copy).toHaveBeenCalledTimes(1);
  });
  it('未知复制查无对象时不盲目再创建', async () => {
    const { repo, drive, engine } = setup();
    const copy = vi.spyOn(drive, 'copy').mockRejectedValue(new OperationError('timeout', 503));
    const p = await engine.preview(request({ kind: 'copy', destination: 'root' }));
    const t = engine.submit(p.id);
    await settled(repo, t.id);
    await engine.control(t.id, 'retry');
    const result = await settled(repo, t.id);
    expect(result.items[0].error).toContain('避免重复创建');
    expect(copy).toHaveBeenCalledTimes(1);
  });
  it('父子同时回收时消除重复项', async () => {
    const { engine } = setup();
    const p = await engine.preview(
      request({ kind: 'trash', ids: ['projects', 'design-a', 'plan'] }),
    );
    expect(p.items.map((i) => i.file.id)).toEqual(['projects']);
  });
  it('禁止目录移动到后代', async () => {
    const { engine } = setup();
    const p = await engine.preview(
      request({ kind: 'move', ids: ['projects'], destination: 'design-a' }),
    );
    expect(p.items[0].blocked).toContain('后代目录');
  });
  it('重启把运行中项目变为待对账并暂停', () => {
    const { repo, drive } = setup();
    const t: Task = {
      id: 'interrupted',
      title: '转让',
      request: request({ kind: 'transfer', targetAccountId: 'demo-work' }),
      createdAt: '2026-10-20',
      updatedAt: '2026-10-20',
      status: 'running',
      paused: false,
      items: [{ file: drive.files[4], mutations: [], changes: [], state: 'running', attempts: 1 }],
    };
    repo.saveTask(t);
    new TaskEngine(repo, drive);
    expect(repo.tasks()[0].items[0].state).toBe('unknown');
    expect(repo.tasks()[0].paused).toBe(true);
  });
});
describe('持久化与输出', () => {
  it('任务逐项持久化、摘要计数和重启对账不丢失其他项目', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'drive-workbench-db-')), 'test.sqlite');
    const db = new SqliteStore(
        path,
        (s) => s,
        (s) => s,
      ),
      drive = new DemoDrive();
    const now = new Date().toISOString();
    const t: Task = {
      id: 'persisted',
      title: '回收站',
      request: request({ kind: 'trash' }),
      createdAt: now,
      updatedAt: now,
      status: 'running',
      paused: false,
      items: drive.files
        .slice(0, 2)
        .map((file) => ({ file, mutations: [], changes: [], state: 'queued', attempts: 0 })),
    };
    db.saveTask(t);
    t.items[0].state = 'succeeded';
    db.saveTask(t, [t.items[0]]);
    t.items[1].state = 'running';
    db.saveTask(t, [t.items[1]]);
    expect(db.taskSummaries()[0]).toMatchObject({ total: 2, succeeded: 1, items: [] });
    db.close();
    const reopened = new SqliteStore(
      path,
      (s) => s,
      (s) => s,
    );
    new TaskEngine(reopened, drive);
    const restored = reopened.tasks()[0];
    expect(restored.items.map((i) => i.state)).toEqual(['succeeded', 'unknown']);
    expect(restored.status).toBe('paused');
    reopened.close();
  });
  it('SQLite 对连接加密且任务可重新读取', () => {
    const encrypt = vi.fn((s) => Buffer.from(s).toString('base64')),
      decrypt = (s: string) => Buffer.from(s, 'base64').toString();
    const db = new SqliteStore(':memory:', encrypt, decrypt);
    db.saveConnection({
      id: 'c',
      accountId: 'a',
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'token',
      expiresAt: 0,
    });
    expect(encrypt).toHaveBeenCalled();
    expect(db.connections()[0].refreshToken).toBe('token');
    db.close();
  });
  it('HTML快照转义不可信名称并包含子树', () => {
    const html = snapshotHtml(
      [
        { id: 'a', name: '<script>alert(1)</script>', mimeType: FOLDER, parents: ['root'] },
        { id: 'b', name: 'child', mimeType: 'text/plain', parents: ['a'] },
      ],
      '测试',
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('child');
  });
});
