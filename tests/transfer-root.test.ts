import { describe, it, expect, vi } from 'vitest';
import { MemoryStore } from '../core/store.js';
import { DemoDrive, DEMO_ACCOUNTS } from '../core/demo.js';
import { TaskEngine, OperationError } from '../core/engine.js';
import { type ActionRequest } from '../core/types.js';

function setup() {
  const repo = new MemoryStore();
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
  const drive = new DemoDrive();
  vi.spyOn(drive as any, 'wait').mockResolvedValue(undefined);
  const get = drive.get.bind(drive),
    permissions = drive.permissions.bind(drive);
  vi.spyOn(drive, 'get').mockImplementation(async (a, id) => {
    const f = await get(a, id);
    return a === 'demo-work' && id === 'root' ? { ...f, id: 'target-root' } : f;
  });
  // Model inherited source access from the actual ancestor tree, rather than
  // assuming a permission deletion succeeds as the simple demo adapter does.
  vi.spyOn(drive, 'permissions').mockImplementation(async (a, id) => {
    const ps = await permissions(a, id);
    let parent = (await get(a, id)).parents[0],
      inherited = false;
    const seen = new Set<string>();
    while (parent && !['root', 'target-root'].includes(parent) && !seen.has(parent)) {
      seen.add(parent);
      if ((await permissions(a, parent)).some((p) => p.id === 'demo-lin')) inherited = true;
      parent = (await get(a, parent)).parents[0];
    }
    return ps.map((p) =>
      p.id === 'demo-lin'
        ? { ...p, permissionDetails: [{ inherited, role: p.role, permissionType: 'file' }] }
        : p,
    );
  });
  const remove = drive.deletePermission.bind(drive);
  const deletes: string[] = [];
  vi.spyOn(drive, 'deletePermission').mockImplementation(async (a, id, pid) => {
    const p = (await drive.permissions(a, id)).find((p) => p.id === pid);
    if (p?.permissionDetails?.some((d) => d.inherited))
      throw new OperationError('cannotDeletePermission', 403);
    deletes.push(id);
    return remove(a, id, pid);
  });
  const engine = new TaskEngine(repo, drive);
  return { repo, drive, engine, deletes };
}
const req = (extra: Partial<ActionRequest> = {}): ActionRequest => ({
  kind: 'transfer',
  accountId: 'demo-lin',
  ids: ['brief'],
  recursive: false,
  targetAccountId: 'demo-work',
  moveToTargetRoot: true,
  removeSource: true,
  ...extra,
});
async function settled(repo: MemoryStore, id: string) {
  for (let n = 0; n < 400; n++) {
    const t = repo.tasks().find((t) => t.id === id)!;
    if (['completed', 'partial', 'paused'].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('Task did not settle');
}

describe('转让后移至目标根目录', () => {
  it('只勾选移动时保留原账号直接编辑权限', async () => {
    const { repo, drive, engine, deletes } = setup();
    const p = await engine.preview(req({ removeSource: false }));
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.status).toBe('completed');
    expect((await drive.get('demo-work', 'brief')).parents).toEqual(['target-root']);
    expect(
      (await drive.permissions('demo-work', 'brief')).find((p) => p.id === 'demo-lin')?.role,
    ).toBe('writer');
    expect(deletes).toEqual([]);
  });
  it('所有权接收后暂停不会继续移动或清理，恢复不重复接收', async () => {
    const { repo, drive, engine, deletes } = setup();
    const accept = drive.updatePermission.bind(drive);
    let accepted = 0;
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const p = await accept(...args);
      if (args[4]) {
        accepted++;
        await engine.control(repo.tasks()[0].id, 'pause');
      }
      return p;
    });
    const move = vi.spyOn(drive, 'update');
    const p = await engine.preview(req());
    const task = engine.submit(p.id);
    await vi.waitFor(() => expect(repo.tasks()[0].items[0].transferVerified).toBe(true));
    expect((await settled(repo, task.id)).status).toBe('paused');
    expect(move).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
    const restored = new TaskEngine(repo, drive);
    await restored.control(task.id, 'retry');
    expect((await settled(repo, task.id)).status).toBe('completed');
    expect(accepted).toBe(1);
  });
  it('未勾选不移动，已转让但继承访问无法移除时明确报告部分结果', async () => {
    const { repo, drive, engine } = setup();
    await drive.update('demo-lin', 'brief', {}, { addParents: 'brand' });
    const move = vi.spyOn(drive, 'update');
    const p = await engine.preview(req({ moveToTargetRoot: false }));
    const t = engine.submit(p.id),
      result = await settled(repo, t.id);
    expect(result.items[0].error).toContain('所有权已转让，但原账号访问未移除');
    expect(result.items[0].error).toContain('父目录继承');
    expect(result.items[0].result).toContain('已确认拥有');
    expect(result.items[0].resultFile?.ownedByMe).toBe(true);
    expect(move).not.toHaveBeenCalled();
  });
  it('以目标账号移动后才移除源权限，复核根目录与完整权限', async () => {
    const { repo, drive, engine, deletes } = setup();
    await drive.update('demo-lin', 'brief', {}, { addParents: 'brand' });
    const move = vi.spyOn(drive, 'update');
    const p = await engine.preview(req());
    expect(p.items[0].changes.join()).toContain('移出原父目录');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.status).toBe('completed');
    expect(move).toHaveBeenCalledWith(
      'demo-work',
      'brief',
      {},
      { addParents: 'target-root', removeParents: 'brand' },
    );
    expect((await drive.get('demo-work', 'brief')).parents).toEqual(['target-root']);
    expect(deletes).toEqual(['brief']);
    expect(result.items[0].resultFile?.permissions?.some((p) => p.id === 'demo-lin')).toBe(false);
    expect(result.items[0].attempts).toBe(1);
  });
  it('递归与父子同时选择只移动顶层，所有权先叶后根、权限清理先根后叶', async () => {
    const { repo, drive, engine, deletes } = setup();
    const ownership: string[] = [];
    const accept = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const p = await accept(...args);
      if (args[4]) ownership.push(args[1]);
      return p;
    });
    const move = vi.spyOn(drive, 'update');
    const p = await engine.preview(req({ ids: ['projects', 'design-a'], recursive: true }));
    expect(p.items.filter((i) => i.transferRoot).map((i) => i.file.id)).toEqual(['projects']);
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.map((i) => i.error).filter(Boolean)).toEqual([]);
    expect(result.status).toBe('completed');
    expect(ownership.indexOf('plan')).toBeLessThan(ownership.indexOf('design-a'));
    expect(ownership.at(-1)).toBe('projects');
    expect(move.mock.calls.map((c) => c[1])).toEqual(['projects']);
    expect((await drive.get('demo-work', 'design-a')).parents).toEqual(['projects']);
    expect((await drive.get('demo-work', 'plan')).parents).toEqual(['design-a']);
    expect(deletes.indexOf('projects')).toBeLessThan(deletes.indexOf('design-a'));
    expect(deletes.indexOf('design-a')).toBeLessThan(deletes.indexOf('plan'));
  });
  it('目标根目录不可写时预览阻止交接', async () => {
    const { drive, engine } = setup();
    const get = vi.mocked(drive.get).getMockImplementation()!;
    vi.mocked(drive.get).mockImplementation(async (a, id) => {
      const f = await get(a, id);
      return a === 'demo-work' && id === 'root'
        ? { ...f, capabilities: { canAddChildren: false } }
        : f;
    });
    const invite = vi.spyOn(drive, 'createPermission');
    await expect(engine.preview(req())).rejects.toThrow('根目录不可写');
    expect(invite).not.toHaveBeenCalled();
  });
  it('移动请求结果未知后重启对账，不重复邀请或重复移动', async () => {
    const { repo, drive, engine } = setup();
    const update = drive.update.bind(drive);
    let lost = true;
    const move = vi.spyOn(drive, 'update').mockImplementation(async (...args) => {
      const f = await update(...args);
      if (lost && args[0] === 'demo-work') {
        lost = false;
        throw new OperationError('网络中断', 503);
      }
      return f;
    });
    const invite = vi.spyOn(drive, 'createPermission');
    const p = await engine.preview(req());
    const task = engine.submit(p.id);
    const before = await settled(repo, task.id);
    expect(before.status).toBe('paused');
    expect(before.items[0].error).toContain('所有权已转让');
    const invitations = invite.mock.calls.length;
    const restarted = new TaskEngine(repo, drive);
    await restarted.control(task.id, 'retry');
    expect((await settled(repo, task.id)).status).toBe('completed');
    expect(invite.mock.calls.length).toBe(invitations);
    expect(move).toHaveBeenCalledTimes(1);
  });
  it('预览后父目录被其他客户端移动时不擅自改动新位置', async () => {
    const { repo, drive, engine, deletes } = setup();
    const p = await engine.preview(req());
    await drive.update('demo-lin', 'brief', {}, { addParents: 'brand' });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items[0].error).toContain('父目录已与预览不同');
    expect(move).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });
  it('整批有未转让项目时不移动目录，避免半完成交接扩大影响', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(req({ ids: ['projects'], recursive: true }));
    const accept = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      if (args[1] === 'plan' && args[4]) throw new OperationError('交接被拒绝', 403);
      return accept(...args);
    });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.status).toBe('partial');
    expect(move).not.toHaveBeenCalled();
    expect(result.items.find((i) => i.file.id === 'projects')?.error).toContain('部分项目尚未验证');
  });
});

describe('统一尽量完成文件夹转让', () => {
  function foreign(drive: DemoDrive, id = 'plan') {
    const get = vi.mocked(drive.get).getMockImplementation()!;
    vi.mocked(drive.get).mockImplementation(async (a, key) => {
      const f = await get(a, key);
      return key === id
        ? { ...f, ownedByMe: false, owners: [{ emailAddress: 'third@example.com' }] }
        : f;
    });
    const list = drive.list.bind(drive);
    vi.spyOn(drive, 'list').mockImplementation(async (...args) => {
      const r = await list(...args);
      r.files = await Promise.all(r.files.map((f) => drive.get(args[0], f.id)));
      return r;
    });
  }
  const mixed = () => req({ ids: ['projects'], recursive: true, skipUntransferable: true });
  it('预览单独列出跳过项，移动顶层且保留层级，不写入跳过项', async () => {
    const { repo, drive, engine, deletes } = setup();
    foreign(drive);
    const invite = vi.spyOn(drive, 'createPermission');
    const accept = vi.spyOn(drive, 'updatePermission');
    const move = vi.spyOn(drive, 'update');
    const p = await engine.preview(mixed());
    expect(p.items.find((i) => i.file.id === 'plan')?.skipReason).toContain('保留原所有者');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.filter((i) => i.state === 'skipped').map((i) => i.file.id)).toEqual([
      'plan',
    ]);
    expect(
      result.items.filter((i) => i.state !== 'skipped').every((i) => i.state === 'succeeded'),
    ).toBe(true);
    expect(result.items.find((i) => i.file.id === 'plan')?.attempts).toBe(0);
    expect(move.mock.calls.map((c) => c[1])).toEqual(['projects']);
    expect((await drive.get('demo-work', 'plan')).parents).toEqual(['design-a']);
    expect(invite.mock.calls.some((c) => c[1] === 'plan')).toBe(false);
    expect(accept.mock.calls.some((c) => c[1] === 'plan')).toBe(false);
    expect(deletes).not.toContain('plan');
    expect(repo.taskSummaries()[0].skipped).toBe(1);
    await expect(engine.control(result.id, 'retry')).rejects.toThrow('没有可继续');
    expect((await settled(repo, result.id)).items.find((i) => i.file.id === 'plan')?.state).toBe(
      'skipped',
    );
  });
  it.each([undefined, false, true])(
    '新预览统一尽量完成，旧参数 %s 不再选择严格模式',
    async (legacyFlag) => {
      const { repo, drive, engine } = setup();
      foreign(drive);
      const p = await engine.preview({ ...mixed(), skipUntransferable: legacyFlag });
      expect(p.request.skipUntransferable).toBe(true);
      expect(p.ownershipNotice).toEqual({ foreign: 1, unknown: 0 });
      expect(p.items.find((i) => i.file.id === 'plan')?.skipReason).toBeTruthy();
      const result = await settled(repo, engine.submit(p.id).id);
      expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('succeeded');
    },
  );
  it('所有者筛选排除非本人项目后仍提示完整扫描中的非本人项目', async () => {
    const { drive, engine } = setup();
    foreign(drive);
    const p = await engine.preview({ ...mixed(), ownerFilter: 'mine' });
    expect(p.ownershipNotice?.foreign).toBe(1);
    expect(p.items.some((i) => i.file.id === 'plan')).toBe(false);
    expect(p.warnings.join()).toContain('筛选排除 1 项');
  });
  it('父子同时选择时非本人项目计数不重复', async () => {
    const { drive, engine } = setup();
    foreign(drive);
    const p = await engine.preview({ ...mixed(), ids: ['projects', 'design-a'] });
    expect(p.ownershipNotice?.foreign).toBe(1);
  });
  it('全部本人所有时不产生非本人提醒', async () => {
    const { engine } = setup();
    const p = await engine.preview(mixed());
    expect(p.ownershipNotice).toEqual({ foreign: 0, unknown: 0 });
  });
  it('历史严格任务恢复时保留冻结策略，不自动跳过', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    const now = new Date().toISOString();
    const task = {
      id: 'old-strict-task',
      title: '历史所有权转让',
      createdAt: now,
      updatedAt: now,
      status: 'queued' as const,
      paused: false,
      request: { ...p.request, skipUntransferable: false },
      items: p.items.map((i) => ({ ...i, state: 'queued' as const, attempts: 0 })),
    };
    repo.saveTask(task);
    const accept = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      if (args[1] === 'plan' && args[4])
        throw new OperationError('明确拒绝', 403, 'insufficientFilePermissions');
      return accept(...args);
    });
    const move = vi.spyOn(drive, 'update');
    const restored = new TaskEngine(repo, drive);
    await restored.control(task.id, 'retry');
    const result = await settled(repo, task.id);
    expect(result.request.skipUntransferable).toBe(false);
    expect(result.items.find((i) => i.file.id === 'plan')?.state).toBe('failed');
    expect(move).not.toHaveBeenCalled();
  });
  it('所有者未知单独提示，不误报为他人所有', async () => {
    const { drive, engine } = setup();
    foreign(drive);
    const get = vi.mocked(drive.get).getMockImplementation()!;
    vi.mocked(drive.get).mockImplementation(async (a, id) => {
      const f = await get(a, id);
      return id === 'plan' ? { ...f, ownedByMe: undefined, owners: [] } : f;
    });
    const p = await engine.preview(mixed());
    expect(p.ownershipNotice).toEqual({ foreign: 0, unknown: 1 });
  });
  it('父文件夹不可转让时不能跳过父文件夹或移动子目录', async () => {
    const { repo, drive, engine } = setup();
    foreign(drive, 'projects');
    const p = await engine.preview(mixed());
    expect(p.items.find((i) => i.file.id === 'projects')?.blocked).toBeTruthy();
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('failed');
    expect(move).not.toHaveBeenCalled();
  });
  it('预览后子项变为他人所有时明确跳过', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    foreign(drive);
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'plan')?.state).toBe('skipped');
    expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('succeeded');
  });
  it.each([
    [403, 'insufficientFilePermissions', 'skipped'],
    [403, 'rateLimitExceeded', 'failed'],
    [403, 'accessNotConfigured', 'failed'],
    [401, '', 'waiting_auth'],
    [503, '', 'unknown'],
  ])('执行拒绝 %s %s 分类为 %s，只有明确权限拒绝可跳过', async (status, reason, state) => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    const accept = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      if (args[1] === 'plan' && args[4]) throw new OperationError('模拟 API 拒绝', status, reason);
      return accept(...args);
    });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'plan')?.state).toBe(state);
    if (state === 'skipped')
      expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('succeeded');
    else expect(move).not.toHaveBeenCalled();
  });
  it('所有权已写入但回包丢失时暂停，恢复后对账且不误跳过', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    const accept = drive.updatePermission.bind(drive);
    let lost = true;
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const value = await accept(...args);
      if (args[1] === 'plan' && args[4] && lost) {
        lost = false;
        throw new OperationError('回包丢失', 503);
      }
      return value;
    });
    const move = vi.spyOn(drive, 'update');
    const task = engine.submit(p.id);
    expect((await settled(repo, task.id)).status).toBe('paused');
    expect(move).not.toHaveBeenCalled();
    const restarted = new TaskEngine(repo, drive);
    await restarted.control(task.id, 'retry');
    const result = await settled(repo, task.id);
    expect(result.status).toBe('completed');
    expect(result.items.some((i) => i.state === 'skipped')).toBe(false);
  });
  it('父文件夹接收被明确拒绝时也不跳过、不移动', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    const accept = drive.updatePermission.bind(drive);
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      if (args[1] === 'projects' && args[4])
        throw new OperationError('父目录拒绝接收', 403, 'insufficientFilePermissions');
      return accept(...args);
    });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('failed');
    expect(move).not.toHaveBeenCalled();
  });
  it('接收后复核读取被拒绝不能误作未转让子项跳过', async () => {
    const { repo, drive, engine } = setup();
    const p = await engine.preview(mixed());
    let accepted = false;
    const accept = drive.updatePermission.bind(drive),
      get = vi.mocked(drive.get).getMockImplementation()!;
    vi.spyOn(drive, 'updatePermission').mockImplementation(async (...args) => {
      const value = await accept(...args);
      if (args[1] === 'plan' && args[4]) accepted = true;
      return value;
    });
    vi.mocked(drive.get).mockImplementation(async (a, id) => {
      if (accepted && a === 'demo-work' && id === 'plan')
        throw new OperationError('复核被拒绝', 403, 'insufficientFilePermissions');
      return get(a, id);
    });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'plan')?.state).toBe('failed');
    expect(move).not.toHaveBeenCalled();
  });
  it('不移动目录时也自动跳过非本人子项，保持原位置', async () => {
    const { repo, drive, engine } = setup();
    foreign(drive);
    const p = await engine.preview({
      ...mixed(),
      moveToTargetRoot: false,
      removeSource: false,
      skipUntransferable: undefined,
    });
    const move = vi.spyOn(drive, 'update');
    const result = await settled(repo, engine.submit(p.id).id);
    expect(result.items.find((i) => i.file.id === 'plan')?.state).toBe('skipped');
    expect(result.items.find((i) => i.file.id === 'projects')?.state).toBe('succeeded');
    expect(move).not.toHaveBeenCalled();
  });
  it('非递归只转让所选对象，不能跳过所选父文件夹', async () => {
    const { drive, engine } = setup();
    foreign(drive, 'projects');
    const p = await engine.preview({ ...mixed(), recursive: false });
    expect(p.items).toHaveLength(1);
    expect(p.request.skipUntransferable).toBe(false);
    expect(p.items[0].blocked).toBeTruthy();
  });
  it('完整扫描失败时无法生成可确认的预览', async () => {
    const { drive, engine } = setup();
    vi.spyOn(drive, 'list').mockResolvedValue({
      files: [],
      complete: false,
      warnings: ['模拟扫描中断'],
    });
    await expect(engine.preview(mixed())).rejects.toThrow('目录扫描不完整');
  });
});
