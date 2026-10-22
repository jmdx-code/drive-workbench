import { randomUUID } from 'node:crypto';
import {
  withApiContext,
  apiEvent,
  emptyCounters,
  RequestPaused,
  interruptibleWait,
} from './telemetry.js';
import { actionProblem } from './access.js';
import type { Repository } from './store.js';
import {
  FOLDER,
  SHORTCUT,
  TITLES,
  type ActionRequest,
  type DriveApi,
  type Plan,
  type PlanItem,
  type Task,
  type TaskItem,
} from './types.js';
import {
  inherited,
  planPermissions,
  signature,
  subject,
  personPermission,
  roleRank,
  matchesOwner,
  ownershipOf,
} from './permissions.js';

export class TaskEngine {
  private plans = new Map<string, Plan>();
  private running = new Map<string, Task>();
  private locks = new Map<string, Promise<void>>();
  private accountPumps = new Map<string, Promise<void>>();
  private fatal = '';
  constructor(
    private repo: Repository,
    private drive: DriveApi,
    private options: { propagationDelays?: number[] } = {},
  ) {
    for (const t of repo.tasks())
      if (t.status === 'running' || t.status === 'queued') {
        t.paused = true;
        t.status = 'paused';
        for (const i of t.items) if (i.state === 'running') i.state = 'unknown';
        repo.saveTask(t);
      }
  }
  get active() {
    return this.running.size > 0;
  }
  get maintenanceBusy() {
    return this.accountPumps.size > 0 || [...this.running.values()].some((t) => !t.paused);
  }
  deleteTasks(ids: string[]) {
    const tasks = this.repo.taskSummaries();
    for (const id of ids) {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error('任务不存在，请刷新记录');
      if (
        ['running', 'queued'].includes(task.status) ||
        (this.running.has(id) &&
          (!this.running.get(id)!.paused || this.accountPumps.has(task.request.accountId)))
      )
        throw new Error('任务仍在执行或等待请求结束，请暂停并等待后再删除');
    }
    this.repo.deleteTasks(ids);
    for (const id of ids) this.running.delete(id);
    return ids.length;
  }
  forgetAccount(id: string) {
    if (this.maintenanceBusy) throw new Error('请暂停任务并等待在途请求结束');
    for (const [key, task] of this.running)
      if (task.request.accountId === id || task.request.targetAccountId === id)
        this.running.delete(key);
    this.plans.clear();
  }
  reset() {
    if (this.maintenanceBusy) throw new Error('请暂停任务并等待在途请求结束');
    this.repo.reset();
    this.running.clear();
    this.plans.clear();
    this.fatal = '';
  }
  private save(t: Task, items: TaskItem[] = []) {
    t.updatedAt = new Date().toISOString();
    try {
      this.repo.saveTask(t, items);
    } catch (e) {
      this.fatal = '本地保存失败，执行已停止';
      for (const x of this.running.values()) x.paused = true;
      throw e;
    }
  }
  private note(i: TaskItem, kind: string, text: string) {
    i.history = [
      ...(i.history || []),
      { time: new Date().toISOString(), kind, message: text },
    ].slice(-40);
  }
  private async propagation(t: Task, i: TaskItem, check: () => Promise<boolean>) {
    for (const ms of this.options.propagationDelays || [1000, 2000, 4000, 8000]) {
      if (t.paused) throw new PauseRequested();
      this.note(i, 'waiting', '等待 Google 同步权限状态');
      this.save(t, [i]);
      await interruptibleWait(ms);
      if (t.paused) throw new PauseRequested();
      apiEvent({ type: 'retry', message: '权限同步复查' });
      if (await check()) return true;
    }
    return false;
  }
  async preview(req: ActionRequest): Promise<Plan> {
    // Freeze the policy for new plans; do not reinterpret existing persisted tasks.
    req = { ...req, skipUntransferable: req.kind === 'transfer' && req.recursive };
    if (req.moveToTargetRoot && req.kind !== 'transfer')
      throw new Error('移至目标根目录仅用于所有权转让');
    if (!this.repo.accounts().some((a) => a.id === req.accountId && a.ready))
      throw new Error('请选择已授权账号');
    if (!Array.isArray(req.ids) || req.ids.length > 20000)
      throw new Error('每批最多 20000 个输入项');
    if (
      req.kind === 'transfer' &&
      (!req.targetAccountId ||
        req.targetAccountId === req.accountId ||
        !this.repo.accounts().some((a) => a.id === req.targetAccountId && a.ready))
    )
      throw new Error('请选择另一个已授权目标账号');
    if (req.kind === 'transfer' && req.moveToTargetRoot) {
      const root = await this.drive.get(req.targetAccountId!, 'root');
      if (root.mimeType !== FOLDER || root.trashed || root.capabilities?.canAddChildren !== true)
        throw new Error('目标账号根目录不可写，不能移动文件');
      req.destination = root.id;
    }
    if (['rename', 'mkdir'].includes(req.kind) && (!req.name?.trim() || req.name.length > 255))
      throw new Error('请输入 1–255 字符的名称');
    if (req.kind === 'rename' && req.ids.length !== 1)
      throw new Error('重命名一次只能选择一个对象');
    if (['move', 'copy', 'mkdir'].includes(req.kind)) {
      req.destination = req.destination || 'root';
      const dest = await this.drive.get(req.accountId, req.destination);
      if (dest.mimeType !== FOLDER || dest.trashed) throw new Error('目的地不是可用文件夹');
      if (dest.capabilities?.canAddChildren !== true)
        throw new Error('目的目录添加文件权限未确认或无权限');
      req.destination = dest.id;
    }
    const reads = new Map<string, Promise<PlanItem['file']>>();
    const read = (id: string) => {
      if (!reads.has(id)) reads.set(id, this.drive.get(req.accountId, id));
      return reads.get(id)!.then((f) => structuredClone(f));
    };
    const files = new Map<string, PlanItem>();
    const warnings: string[] = [];
    const excluded = new Set<string>();
    const descendants = new Map<string, PlanItem['file']>();
    const insert = (f: PlanItem['file']) => {
      if (
        req.kind !== 'mkdir' &&
        !matchesOwner(
          f,
          req.ownerFilter,
          this.repo.accounts().find((a) => a.id === req.accountId),
        )
      ) {
        excluded.add(f.id);
        return;
      }
      files.set(f.id, { file: f, mutations: [], changes: [] });
    };
    if (req.kind === 'mkdir')
      insert({
        id: `new-${randomUUID()}`,
        name: req.name!,
        mimeType: FOLDER,
        parents: [req.destination!],
      });
    else {
      const selected = new Map<string, PlanItem['file']>();
      await parallel([...new Set(req.ids)], this.repo.settings().accountConcurrency, async (id) => {
        selected.set(id, await read(id));
      });
      for (const f of selected.values()) insert(f);
      const scanned = new Map<string, Promise<Awaited<ReturnType<DriveApi['list']>>>>();
      const scan = (f: PlanItem['file']) => {
        if (!scanned.has(f.id))
          scanned.set(
            f.id,
            this.drive.list(req.accountId, f.id, true, false, undefined, undefined, f),
          );
        return scanned.get(f.id)!;
      };
      const covered = new Set<string>();
      if (req.recursive)
        await parallel(
          [...selected.values()],
          this.repo.settings().accountConcurrency,
          async (f) => {
            let parent = f.parents[0];
            const seen = new Set<string>();
            while (parent && parent !== 'root' && !seen.has(parent)) {
              seen.add(parent);
              if (selected.get(parent)?.mimeType === FOLDER) {
                covered.add(f.id);
                break;
              }
              try {
                parent = (selected.get(parent) || (await read(parent))).parents[0];
              } catch {
                break;
              } // An unreadable external ancestor cannot justify excluding a selected subtree.
            }
          },
        );
      const roots = [...selected.values()].filter((f) => !covered.has(f.id));
      await parallel(roots, this.repo.settings().accountConcurrency, async (f) => {
        if (
          req.recursive &&
          f.mimeType === FOLDER &&
          req.kind !== 'trash' &&
          req.kind !== 'restore'
        ) {
          const result = await scan(f);
          if (!result.complete)
            throw new Error(`目录扫描不完整，禁止提交：${result.warnings.join('；')}`);
          result.files.forEach((child) => {
            descendants.set(child.id, child);
            insert(child);
          });
        }
      });
    }
    if (excluded.size)
      warnings.push(`按所有者筛选排除 ${excluded.size} 项，不执行这些项目的直接变更`);
    if (files.size === 0) throw new Error('当前所有者筛选下没有可执行文件，请检查选择和所有者');
    if (files.size > 20000) throw new Error('展开后超过 20000 项，请拆分批次');
    // Trashing a selected ancestor already includes its descendants; do not issue duplicate changes.
    if (req.kind === 'trash' || req.kind === 'restore')
      for (const [id, item] of files) {
        let parents = item.file.parents;
        const seen = new Set<string>();
        while (parents.length) {
          const pid = parents[0];
          if (seen.has(pid)) break;
          seen.add(pid);
          if (files.has(pid)) {
            files.delete(id);
            break;
          }
          try {
            parents = (await read(pid)).parents;
          } catch {
            break;
          }
        }
      }
    const ancestorReads = new Map<string, Promise<PlanItem['file']>>();
    const selectedTransferIds = new Set(req.ids);
    const ancestorFile = (id: string) => {
      if (files.has(id)) return Promise.resolve(files.get(id)!.file);
      if (!ancestorReads.has(id)) ancestorReads.set(id, read(id));
      return ancestorReads.get(id)!;
    };
    await parallel([...files.values()], this.repo.settings().accountConcurrency, async (item) => {
      let parent = item.file.parents[0],
        depth = 0;
      const seen = new Set<string>();
      while (parent && files.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        depth++;
        parent = files.get(parent)!.file.parents[0];
      }
      item.file.depth = depth;
      if (req.kind === 'transfer') {
        // Only move frozen selection roots; moving their descendants separately would flatten the tree.
        item.transferRoot = selectedTransferIds.has(item.file.id);
        let ancestor = item.file.parents[0];
        const visited = new Set<string>();
        while (
          ancestor &&
          ancestor !== 'root' &&
          !visited.has(ancestor) &&
          (files.has(ancestor) || selectedTransferIds.size > 1)
        ) {
          visited.add(ancestor);
          if (selectedTransferIds.has(ancestor)) item.transferRoot = false;
          ancestor = (await ancestorFile(ancestor)).parents[0];
        }
        item.file.depth = Math.max(depth, visited.size);
      }
      const f = item.file;
      try {
        if (req.kind !== 'mkdir') {
          const problem = actionProblem(
            req.kind,
            f,
            this.repo.accounts().find((a) => a.id === req.accountId),
            req.share,
          );
          if (problem) throw new Error(problem);
        }
        if (
          f.id === 'root' ||
          (f.parents.length === 0 && f.mimeType === FOLDER && req.kind !== 'mkdir')
        )
          throw new Error('根目录不可执行此操作');
        if (f.trashed && req.kind !== 'restore') throw new Error('对象位于回收站');
        if (req.kind === 'share') {
          if (!req.share) throw new Error('缺少分享设置');
          if (f.capabilities?.canShare === false) throw new Error('当前账号没有分享管理权限');
          const ps = await this.drive.permissions(req.accountId, f.id);
          item.signature = signature(ps);
          const cfg = {
            ...req.share,
            people: req.share.mappings
              ? req.share.mappings.filter((m) => m.fileId === f.id).map((m) => m.person)
              : req.share.people,
          };
          item.mutations = planPermissions(ps, cfg);
          item.changes = item.mutations.map((m) => m.label);
          if (cfg.writersCanShare !== 'keep')
            item.changes.push(`编辑者再分享：${cfg.writersCanShare === 'yes' ? '允许' : '限制'}`);
          if (cfg.copyRestriction !== 'keep')
            item.changes.push(
              `查看者复制/下载/打印限制：${cfg.copyRestriction === 'yes' ? '开启' : '关闭'}`,
            );
        } else if (req.kind === 'transfer') {
          if (f.capabilities?.canShare === false) throw new Error('没有转让所需的分享管理权限');
          if (f.driveId) throw new Error('共享云端硬盘没有个人所有权');
          if (f.mimeType === SHORTCUT) throw new Error('快捷方式暂不转让，请选择实际文件');
          if (!f.ownedByMe) throw new Error('源账号不是所有者');
          item.changes = [
            '源账号发起转让',
            '目标账号自动接收',
            '验证目标所有者',
            ...(req.moveToTargetRoot
              ? [
                  item.transferRoot
                    ? `移出原父目录，移至目标账号根目录 ${req.destination}`
                    : '保留内部层级，随所选顶层目录移动',
                ]
              : []),
            ...(req.removeSource ? ['验证后移除原所有者访问'] : ['保留原所有者编辑权限']),
          ];
        } else if (req.kind === 'rename' && f.capabilities?.canRename === false)
          throw new Error('当前账号不能重命名该对象');
        else if (req.kind === 'copy' && f.capabilities?.canCopy === false)
          throw new Error('当前账号不能创建该文件的副本');
        else if (req.kind === 'copy' && f.mimeType === FOLDER)
          throw new Error('文件夹不能直接复制，请选择其中的文件');
        else if (req.kind === 'move') {
          let dest = req.destination!;
          const seen = new Set<string>();
          while (dest !== 'root' && !seen.has(dest)) {
            if (dest === f.id) throw new Error('不能移动到自身或后代目录');
            seen.add(dest);
            dest = (await read(dest)).parents[0] || 'root';
          }
          if (f.capabilities?.canMoveItemWithinDrive === false)
            throw new Error('当前账号不能移动此项目');
          item.changes = [`移动到 ${req.destination}`];
        } else if (req.kind === 'trash' && f.capabilities?.canTrash === false)
          throw new Error('没有移入回收站的权限');
        else if (req.kind === 'restore' && f.capabilities?.canUntrash === false)
          throw new Error('没有恢复权限');
        if (!item.changes.length && req.kind !== 'share')
          item.changes = [req.kind === 'rename' ? `名称 → ${req.name}` : TITLES[req.kind]];
      } catch (e) {
        if (req.skipUntransferable && !item.transferRoot && req.kind === 'transfer') {
          item.skipReason = `跳过所有权转让：${message(e)}；保留原所有者，目录移动仍可能改变继承访问`;
          item.changes = [];
        } else item.blocked = message(e);
      }
    });
    const plan: Plan = {
      id: randomUUID(),
      request: structuredClone(req),
      createdAt: new Date().toISOString(),
      items: [...files.values()],
      complete: true,
      warnings,
      ...(req.kind === 'transfer' && req.recursive
        ? {
            ownershipNotice: {
              foreign: [...descendants.values()].filter(
                (f) =>
                  ownershipOf(
                    f,
                    this.repo.accounts().find((a) => a.id === req.accountId),
                  ) === 'others',
              ).length,
              unknown: [...descendants.values()].filter(
                (f) =>
                  ownershipOf(
                    f,
                    this.repo.accounts().find((a) => a.id === req.accountId),
                  ) === 'unknown',
              ).length,
            },
          }
        : {}),
    };
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }
  submit(id: string) {
    const plan = this.plans.get(id);
    if (!plan) throw new Error('预览已过期，请重新预览');
    if (Date.now() - Date.parse(plan.createdAt) > 15 * 60 * 1000)
      throw new Error('预览超过15分钟，请重新生成');
    if (plan.items.every((i) => i.blocked || i.skipReason)) throw new Error('没有可执行项目');
    const now = new Date().toISOString();
    const t: Task = {
      id: randomUUID(),
      title: TITLES[plan.request.kind],
      request: plan.request,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      paused: false,
      items: plan.items.map((i) => ({
        ...i,
        state: i.blocked ? 'failed' : i.skipReason ? 'skipped' : 'queued',
        result: i.skipReason,
        error: i.blocked,
        attempts: 0,
      })),
    };
    this.save(t, t.items);
    this.plans.delete(id);
    this.running.set(t.id, t);
    void this.pump();
    return structuredClone(t);
  }
  async control(id: string, action: 'pause' | 'resume' | 'retry') {
    let t = this.running.get(id) || this.repo.tasks().find((t) => t.id === id);
    if (!t) throw new Error('任务不存在');
    if (action === 'pause') {
      t.paused = true;
      t.status = 'paused';
      const active = t.items.filter((i) => i.state === 'running');
      for (const i of active) this.note(i, 'paused', '用户暂停；已完成步骤已保存');
      this.save(t, active);
      return;
    }
    if (this.fatal) throw new Error(this.fatal);
    if (
      !t.items.some(
        (i) =>
          !i.blocked &&
          ['queued', 'running', 'unknown', 'failed', 'waiting_auth', 'cancelled'].includes(i.state),
      )
    )
      throw new Error('没有可继续的项目；预检被阻止的对象需要重新生成计划');
    for (const i of t.items)
      if (
        !i.blocked &&
        (i.state === 'failed' || i.state === 'waiting_auth' || i.state === 'cancelled')
      ) {
        i.state = 'queued';
        i.error = undefined;
      }
    t.paused = false;
    t.status = 'queued';
    this.save(t, t.items);
    this.running.set(t.id, t);
    void this.pump();
  }
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(id, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  private async pump() {
    for (const account of new Set(
      [...this.running.values()].filter((t) => !t.paused).map((t) => t.request.accountId),
    )) {
      if (this.accountPumps.has(account) || this.fatal) continue;
      const job = Promise.resolve().then(() => this.pumpAccount(account));
      this.accountPumps.set(account, job);
      void job.finally(() => {
        this.accountPumps.delete(account);
        if (
          !this.fatal &&
          [...this.running.values()].some(
            (t) =>
              !t.paused &&
              t.request.accountId === account &&
              t.items.some((i) => i.state === 'queued' || i.state === 'unknown'),
          )
        )
          void this.pump();
      });
    }
    await Promise.all(this.accountPumps.values());
  }
  private async pumpAccount(accountId: string) {
    try {
      while (!this.fatal) {
        const candidates = [...this.running.values()].filter(
          (t) => !t.paused && t.request.accountId === accountId,
        );
        let found = false;
        const work: { t: Task; i: TaskItem }[] = [];
        const accountWorkers = new Map<string, number>();
        // A transfer batch runs leaves before ancestors by waiting for each depth level.
        for (const t of candidates) {
          let pending = t.items.filter((i) => i.state === 'queued' || i.state === 'unknown');
          const stagedTransfer = t.request.kind === 'transfer' && t.request.moveToTargetRoot;
          const ownershipPending = stagedTransfer && pending.some((i) => !i.transferVerified);
          if (ownershipPending) pending = pending.filter((i) => !i.transferVerified);
          const depth =
            stagedTransfer && !ownershipPending
              ? Math.min(...pending.map((i) => i.file.depth || 0))
              : Math.max(...pending.map((i) => i.file.depth || 0));
          for (const i of pending) {
            if (
              ['transfer', 'share'].includes(t.request.kind) &&
              (t.request.recursive || stagedTransfer) &&
              (i.file.depth || 0) !== depth
            )
              continue;
            const account = t.request.accountId;
            if ((accountWorkers.get(account) || 0) >= this.repo.settings().accountConcurrency)
              break;
            accountWorkers.set(account, (accountWorkers.get(account) || 0) + 1);
            work.push({ t, i });
          }
        }
        if (!work.length) break;
        await Promise.all(
          work.map(async ({ t, i }) => {
            if (t.paused || this.fatal) return;
            found = true;
            i.state = 'running';
            if (t.request.moveToTargetRoot && i.transferVerified && !i.transferCleanupStarted)
              i.transferCleanupStarted = true;
            else i.attempts++;
            t.status = 'running';
            this.save(t, [i]);
            try {
              const executed = await this.locked(i.file.id, async () => {
                if (t.paused) return false;
                await withApiContext(
                  (event) => {
                    i.api ??= emptyCounters();
                    if (event.type === 'request')
                      i.api[event.method === 'GET' ? 'reads' : 'writes']++;
                    else {
                      i.api[event.type === 'retry' ? 'retries' : 'rateLimits']++;
                      this.note(i, event.type, event.message);
                    }
                  },
                  () => t.paused,
                  () => this.execute(t, i),
                );
                return true;
              });
              i.state = executed ? 'succeeded' : 'queued';
              i.error = undefined;
            } catch (e) {
              if (
                e instanceof PauseRequested ||
                e instanceof RequestPaused ||
                e instanceof TransferStageReady
              ) {
                i.state = 'queued';
                i.error = undefined;
                this.save(t, [i]);
                return;
              }
              if (
                e instanceof TransferCannotProceed &&
                t.request.skipUntransferable &&
                !i.transferRoot &&
                !i.transferVerified &&
                i.attempts === 1
              ) {
                i.state = 'skipped';
                i.skipReason = `跳过所有权转让：${message(e)}；保留原所有者，目录移动仍可能改变继承访问`;
                i.result = i.skipReason;
                i.error = undefined;
                this.save(t, [i]);
                return;
              }
              const code = (e as { status?: number }).status;
              i.error = message(e);
              this.note(i, 'error', i.error);
              i.state =
                code === 401
                  ? 'waiting_auth'
                  : code === undefined || code >= 500
                    ? 'unknown'
                    : 'failed';
            }
            this.save(t, [i]);
          }),
        );
        for (const t of candidates) {
          if (t.items.some((i) => i.state === 'unknown' || i.state === 'waiting_auth')) {
            t.paused = true;
            for (const i of t.items)
              if (i.state === 'unknown' || i.state === 'waiting_auth')
                this.note(i, 'paused', i.error || '需要对账或重新授权');
            t.status = 'paused';
          } else if (!t.items.some((i) => i.state === 'queued' || i.state === 'running')) {
            t.status = t.items.some((i) => i.state !== 'succeeded') ? 'partial' : 'completed';
            this.running.delete(t.id);
          } else if (t.paused) t.status = 'paused';
          this.save(
            t,
            t.items.filter((i) => i.state === 'unknown' || i.state === 'waiting_auth'),
          );
        }
        if (!found) break;
      }
    } catch (e) {
      this.fatal = message(e);
      for (const t of this.running.values()) t.paused = true;
    }
  }
  private async execute(t: Task, i: TaskItem) {
    const r = t.request,
      a = r.accountId,
      id = i.file.id;
    const marker = `${t.id}:${id}`;
    if (r.kind === 'mkdir' || r.kind === 'copy') {
      const existing = await this.drive.findOperation(a, marker);
      if (existing) {
        i.outputId = existing.id;
        i.resultFile = existing;
        i.result = `已确认创建：${existing.name}`;
        return;
      }
      if (i.attempts > 1)
        throw new OperationError(
          '未找到已创建对象，但上次结果未知。为避免重复创建，请核查网盘后重新建立任务。',
          409,
        );
      const copySource = r.kind === 'copy' ? await this.drive.get(a, id) : undefined;
      if (
        r.kind === 'copy' &&
        r.ownerFilter &&
        r.ownerFilter !== 'all' &&
        !matchesOwner(
          copySource!,
          r.ownerFilter,
          this.repo.accounts().find((x) => x.id === a),
        )
      )
        throw new OperationError('文件所有者已不符合筛选范围，请重新预览', 409);
      const body = {
        name: r.name || `${i.file.name} 的副本`,
        parents: [r.destination || 'root'],
        appProperties: { driveWorkbench: marker },
      };
      const dest = await this.drive.get(a, r.destination || 'root');
      if (dest.trashed || dest.mimeType !== FOLDER || dest.capabilities?.canAddChildren !== true)
        throw new OperationError('目的目录不可写，请重新预览', 403);
      if (r.kind === 'copy') {
        const problem = actionProblem(
          'copy',
          copySource!,
          this.repo.accounts().find((x) => x.id === a),
        );
        if (problem) throw new OperationError(problem, 403);
      }
      const result =
        r.kind === 'mkdir'
          ? await this.drive.create(a, { ...body, mimeType: FOLDER })
          : await this.drive.copy(a, id, body);
      i.outputId = result.id;
      i.resultFile = result;
      i.result = `已创建：${result.name}`;
      return;
    }
    if (r.kind === 'transfer') {
      await this.transfer(t, i);
      return;
    }
    const current = await this.drive.get(a, id);
    const needsWrite =
      r.kind === 'share' ||
      (r.kind === 'rename' && current.name !== r.name) ||
      (r.kind === 'move' && !current.parents.includes(r.destination!)) ||
      (r.kind === 'trash' && !current.trashed) ||
      (r.kind === 'restore' && current.trashed);
    if (needsWrite) {
      const problem = actionProblem(
        r.kind,
        current,
        this.repo.accounts().find((x) => x.id === a),
        r.share,
      );
      if (problem) throw new OperationError(problem, 403);
    }
    if (
      !matchesOwner(
        current,
        r.ownerFilter,
        this.repo.accounts().find((x) => x.id === a),
      )
    )
      throw new OperationError('文件所有者已不符合筛选范围，请重新预览', 409);
    let checkedPermissions: Awaited<ReturnType<DriveApi['permissions']>> | undefined;
    if (!i.started) {
      if (JSON.stringify(current.parents) !== JSON.stringify(i.file.parents))
        throw new OperationError('文件位置在预览后发生变化，请重新预览', 409);
      if (current.ownedByMe !== i.file.ownedByMe)
        throw new OperationError('所有者状态已变化，请重新预览', 409);
      if (r.kind === 'rename' && current.name !== i.file.name && current.name !== r.name)
        throw new OperationError('名称在预览后发生变化，请重新预览', 409);
      if (r.kind === 'share') {
        checkedPermissions = await this.drive.permissions(a, id);
        if (signature(checkedPermissions) !== i.signature)
          throw new OperationError('权限已在预览后变化，请重新生成计划', 409);
      }
      i.started = true;
      this.save(t, [i]);
    }
    if (r.kind === 'share') {
      let finalPermissions = checkedPermissions || current.permissions;
      for (const m of i.mutations) {
        if (t.paused) throw new PauseRequested();
        const ps =
          m.kind === 'delete' || !checkedPermissions
            ? await this.drive.permissions(a, id)
            : checkedPermissions;
        checkedPermissions = undefined;
        finalPermissions = ps;
        if (m.kind === 'create') {
          const existing = ps.find((p) => subject(p) === subject(m.permission!));
          if (existing) {
            if (existing.role !== m.permission!.role)
              throw new OperationError('目标权限出现冲突，请重新预览', 409);
            continue;
          }
          await this.drive.createPermission(a, id, m.permission!, r.share!.notify);
        } else if (m.kind === 'update') {
          const p = ps.find((p) => p.id === m.id);
          if (!p) throw new OperationError('待修改权限已不存在', 409);
          if (p.role !== m.permission!.role)
            await this.drive.updatePermission(a, id, m.id!, m.permission!);
        } else {
          const p = ps.find((p) => p.id === m.id);
          if (!p) continue;
          if (r.share!.collaborators === 'replace') {
            const people = r.share!.mappings
              ? r.share!.mappings.filter((x) => x.fileId === id).map((x) => x.person)
              : r.share!.people;
            for (const person of people) {
              const expected = personPermission(person),
                actual = ps.find((p) => subject(p) === subject(expected));
              if (
                !actual ||
                (actual.role !== 'owner' &&
                  (r.share!.atLeast
                    ? roleRank(actual.role) < roleRank(person.role)
                    : actual.role !== person.role))
              )
                throw new OperationError('目标协作者权限已变化，保留旧权限并暂停替换', 409);
            }
          }
          if (p.role === 'owner' || inherited(p))
            throw new OperationError('拒绝删除所有者或继承权限', 409);
          await this.drive.deletePermission(a, id, m.id!);
        }
        const after = await this.drive.permissions(a, id);
        finalPermissions = after;
        checkedPermissions = after;
        if (
          m.kind === 'delete'
            ? after.some((p) => p.id === m.id)
            : !after.some(
                (p) =>
                  (m.kind === 'create' ? subject(p) === subject(m.permission!) : p.id === m.id) &&
                  p.role === m.permission!.role,
              )
        )
          throw new OperationError('权限写入后尚未验证，请重试对账', 503);
      }
      const body: Record<string, unknown> = {};
      if (t.paused) throw new PauseRequested();
      if (r.share!.writersCanShare !== 'keep')
        body.writersCanShare = r.share!.writersCanShare === 'yes';
      if (r.share!.copyRestriction !== 'keep')
        body.copyRequiresWriterPermission = r.share!.copyRestriction === 'yes';
      if (Object.keys(body).length) {
        await this.drive.update(a, id, body);
        const after = await this.drive.get(a, id);
        for (const [k, v] of Object.entries(body))
          if ((after as unknown as Record<string, unknown>)[k] !== v)
            throw new OperationError('分享限制未能复核', 503);
      }
      i.resultFile = { ...current, ...body, permissions: finalPermissions };
      i.result = i.mutations.length ? `已验证 ${i.mutations.length} 项权限变更` : '设置已满足';
      return;
    }
    if (r.kind === 'rename') {
      if (current.name !== r.name) await this.drive.update(a, id, { name: r.name });
    }
    if (r.kind === 'trash' || r.kind === 'restore') {
      const wanted = r.kind === 'trash';
      if (!!current.trashed !== wanted) await this.drive.update(a, id, { trashed: wanted });
    }
    if (r.kind === 'move' && !current.parents.includes(r.destination!)) {
      const dest = await this.drive.get(a, r.destination!);
      if (dest.trashed || dest.mimeType !== FOLDER || dest.capabilities?.canAddChildren !== true)
        throw new OperationError('目的目录不可写，请重新预览', 403);
      await this.drive.update(
        a,
        id,
        {},
        { addParents: r.destination!, removeParents: current.parents.join(',') },
      );
    }
    const after = await this.drive.get(a, id);
    if (
      (r.kind === 'rename' && after.name !== r.name) ||
      (r.kind === 'trash' && !after.trashed) ||
      (r.kind === 'restore' && after.trashed) ||
      (r.kind === 'move' && !after.parents.includes(r.destination!))
    )
      throw new OperationError('结果尚未确认，请重新对账', 503);
    i.resultFile = after;
    i.result = '已完成并复核';
  }
  private async transfer(t: Task, i: TaskItem) {
    const a = t.request.accountId,
      b = t.request.targetAccountId!,
      id = i.file.id,
      target = this.repo.accounts().find((x) => x.id === b)!,
      source = this.repo.accounts().find((x) => x.id === a)!;
    let targetFile: PlanItem['file'] | undefined;
    const targetRead = async () => {
      try {
        return await this.drive.get(b, id);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
        return undefined;
      }
    };
    if (i.attempts > 1 || i.transferStage || i.transferVerified) targetFile = await targetRead();
    if (
      !targetFile?.ownedByMe &&
      !['invited', 'accepting', 'accepted'].includes(i.transferStage || '')
    ) {
      const f = await this.drive.get(a, id);
      if (!f.ownedByMe) {
        targetFile = await targetRead();
        if (!targetFile?.ownedByMe)
          throw new TransferCannotProceed('源账号已不拥有文件，且目标账号未确认拥有', 409);
      } else {
        if (f.trashed || f.driveId) throw new TransferCannotProceed('文件当前不允许转让', 409);
        const problem = actionProblem('transfer', f, source);
        if (problem) throw new TransferCannotProceed(problem, 403);
        const ps = await this.drive.permissions(a, id);
        if (
          ps.some(
            (p) => p.pendingOwner && p.emailAddress?.toLowerCase() !== target.email.toLowerCase(),
          )
        )
          throw new OperationError('存在发给其他账号的待接收转让', 409);
        let p = ps.find(
          (p) => p.type === 'user' && p.emailAddress?.toLowerCase() === target.email.toLowerCase(),
        );
        if (!p?.pendingOwner && p?.role !== 'owner') {
          if (i.transferStage === 'inviting')
            throw new OperationError('上次邀请结果尚未确认，未重复发送；请稍后对账', 503);
          if (t.paused) throw new PauseRequested();
          i.transferStage = 'inviting';
          this.save(t, [i]);
          try {
            p = p
              ? await this.drive.updatePermission(a, id, p.id, {
                  role: 'writer',
                  pendingOwner: true,
                })
              : await this.drive.createPermission(
                  a,
                  id,
                  { type: 'user', emailAddress: target.email, role: 'writer', pendingOwner: true },
                  true,
                );
          } catch (e) {
            if ((e as { status?: number }).status && (e as { status: number }).status < 500) {
              i.transferStage = undefined;
              this.save(t, [i]);
            }
            throw transferRejection(e);
          }
        }
        if (p?.role === 'owner') {
          targetFile = await targetRead();
          if (!targetFile?.ownedByMe)
            throw new OperationError('目标所有者尚未验证，保留任务待对账', 503);
        } else {
          if (!p?.id) throw new OperationError('邀请响应没有权限 ID，保留任务待对账', 503);
          i.transferPermissionId = p.id;
          i.transferStage = 'invited';
          this.note(i, 'stage', '转让邀请已确认');
          this.save(t, [i]);
        }
      }
    }
    if (!targetFile?.ownedByMe && i.transferStage !== 'accepted') {
      // Legacy tasks and interrupted acceptance must reconcile before any new write.
      if (!i.transferPermissionId || i.transferStage === 'accepting') {
        let ready = false;
        const check = async () => {
          targetFile = await targetRead();
          if (targetFile?.ownedByMe) return true;
          const ps = await this.drive.permissions(b, id);
          const p = ps.find(
            (p) =>
              p.id === target.permissionId ||
              p.emailAddress?.toLowerCase() === target.email.toLowerCase(),
          );
          if (p?.pendingOwner) {
            i.transferPermissionId = p.id;
            ready = true;
          }
          return ready;
        };
        if (!(await check()) && !(await this.propagation(t, i, check)))
          throw new OperationError('目标尚未确认待接收权限，请稍后重试', 503);
      }
      if (!targetFile?.ownedByMe) {
        if (t.paused) throw new PauseRequested();
        i.transferStage = 'accepting';
        this.save(t, [i]);
        try {
          await this.drive.updatePermission(
            b,
            id,
            i.transferPermissionId!,
            { role: 'owner' },
            true,
          );
        } catch (e) {
          // A definitive rejection can be propagation lag. Recheck only this step;
          // never repeat an unknown write or send another invitation here.
          if ((e as { status?: number }).status !== 403) throw e;
          let ready = false;
          const check = async () => {
            const ps = await this.drive.permissions(b, id);
            const p = ps.find((p) => p.id === i.transferPermissionId);
            if (p?.role === 'owner') {
              targetFile = await targetRead();
              return !!targetFile?.ownedByMe;
            }
            return (ready = p?.pendingOwner === true);
          };
          if (!(await check()) && !(await this.propagation(t, i, check)))
            throw new OperationError('目标尚未确认待接收权限，请稍后重试', 503);
          if (ready && !targetFile?.ownedByMe) {
            if (t.paused) throw new PauseRequested();
            apiEvent({ type: 'retry', message: '权限同步后重试接收' });
            try {
              await this.drive.updatePermission(
                b,
                id,
                i.transferPermissionId!,
                { role: 'owner' },
                true,
              );
            } catch (again) {
              throw transferRejection(again);
            }
          }
        }
        i.transferStage = 'accepted';
        this.note(i, 'stage', '目标已接收，等待所有者复核');
        this.save(t, [i]);
      }
    }
    let verified = targetFile?.ownedByMe ? targetFile : await this.drive.get(b, id);
    if (!verified.ownedByMe) {
      const check = async () => {
        verified = await this.drive.get(b, id);
        return !!verified.ownedByMe;
      };
      if (!(await this.propagation(t, i, check)))
        throw new OperationError('目标所有者尚未验证，保留任务待对账', 503);
    }
    i.transferStage = 'verified';
    i.resultFile = verified;
    i.result = `目标 ${target.email} 已确认拥有`;
    if (t.request.moveToTargetRoot && !i.transferVerified) {
      i.transferVerified = true;
      i.result += '；等待整批所有权验证后移动目录并清理权限';
      throw new TransferStageReady();
    }
    if (t.request.moveToTargetRoot) {
      if (
        t.items.some(
          (item) =>
            !item.transferVerified &&
            !(t.request.skipUntransferable && !item.transferRoot && item.state === 'skipped'),
        )
      )
        throw new OperationError(
          '所有权已转让，但部分项目尚未验证；未移动目录或清理原账号访问，请重试对账',
          409,
        );
      if (i.transferRoot) {
        if (t.paused) throw new PauseRequested();
        try {
          const root = await this.drive.get(b, 'root');
          if (
            root.id !== t.request.destination ||
            root.trashed ||
            root.capabilities?.canAddChildren !== true
          )
            throw new OperationError('目标根目录不可写或与预览不符', 403);
          if (!verified.parents.includes(root.id) || verified.parents.some((p) => p !== root.id)) {
            if (
              JSON.stringify([...verified.parents].sort()) !==
              JSON.stringify([...i.file.parents].sort())
            )
              throw new OperationError('父目录已与预览不同，未移动；请核查后重新预览', 409);
            if (verified.capabilities?.canMoveItemWithinDrive !== true)
              throw new OperationError('目标账号当前不能移动此项目', 403);
            await this.drive.update(
              b,
              id,
              {},
              {
                addParents: root.id,
                ...(verified.parents.some((p) => p !== root.id)
                  ? { removeParents: verified.parents.filter((p) => p !== root.id).join(',') }
                  : {}),
              },
            );
            verified = await this.drive.get(b, id);
            if (
              !verified.ownedByMe ||
              verified.parents.length !== 1 ||
              verified.parents[0] !== root.id
            )
              throw new OperationError('移动结果尚未验证，请重试对账', 503);
          }
          i.resultFile = verified;
          i.result += '；已移至目标账号根目录';
        } catch (e) {
          throw new OperationError(
            `所有权已转让，但移至目标根目录未完成：${message(e)}`,
            (e as { status?: number }).status || 503,
          );
        }
      } else {
        // A failed ancestor move must not be followed by permission removal on its children.
        if (t.items.some((item) => item.transferRoot && item.state !== 'succeeded'))
          throw new OperationError(
            '所有权已转让，但顶层目录移动未完成；保留原账号访问，请重试对账',
            409,
          );
        i.result += '；内部目录层级保留';
      }
    }
    if (t.request.removeSource) {
      if (t.paused) throw new PauseRequested();
      try {
        const ps = await this.drive.permissions(b, id);
        const p = ps.find(
          (p) =>
            p.id === source.permissionId ||
            p.emailAddress?.toLowerCase() === source.email.toLowerCase(),
        );
        if (p && inherited(p))
          throw new OperationError(
            '原账号仍有父目录继承权限，不能直接删除；可选择移至目标账号根目录或检查父目录',
            403,
          );
        if (p?.role === 'owner') throw new OperationError('原账号仍显示为所有者，未删除权限', 409);
        if (p) await this.drive.deletePermission(b, id, p.id);
        const after = await this.drive.permissions(b, id);
        if (
          after.some(
            (p) =>
              p.id === source.permissionId ||
              p.emailAddress?.toLowerCase() === source.email.toLowerCase(),
          )
        )
          throw new OperationError('所有权已转让，但原账号访问尚未移除', 503);
        i.resultFile = { ...verified, permissions: after };
        i.result += '；原账号访问已移除';
      } catch (e) {
        throw new OperationError(
          `所有权已转让，但原账号访问未移除：${message(e)}`,
          (e as { status?: number }).status || 503,
        );
      }
    }
  }
}
// Only definitive metadata failures or explicit ownership-write rejections may be skipped.
function transferRejection(e: unknown): unknown {
  const failure = e as { status?: number; reason?: string };
  return failure.status === 403 &&
    [
      'insufficientFilePermissions',
      'ownershipChangeAcrossDomainsNotPermitted',
      'cannotTransferOwnership',
      'domainPolicy',
    ].includes(failure.reason || '')
    ? new TransferCannotProceed(message(e), 403)
    : e;
}
class TransferCannotProceed extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
  }
}
export class OperationError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
  }
}
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
class PauseRequested extends Error {}
class TransferStageReady extends Error {}
async function parallel<T>(values: T[], limit: number, fn: (value: T) => Promise<void>) {
  let index = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (index < values.length && !failure) {
        const value = values[index++];
        try {
          await fn(value);
        } catch (e) {
          failure = e;
        }
      }
    }),
  );
  if (failure) throw failure;
}
