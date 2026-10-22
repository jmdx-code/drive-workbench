import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  Menu,
  clipboard,
  nativeImage,
} from 'electron';
import { AvatarCache } from '../core/avatars.js';
import { PortableUpdater } from '../core/updater.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SqliteStore, MemoryStore, type Repository } from '../core/store.js';
import { AuthService } from '../core/auth.js';
import { GoogleDrive } from '../core/drive.js';
import { TaskEngine } from '../core/engine.js';
import { sumCounters } from '../core/telemetry.js';
import { snapshotHtml, snapshotCsv } from '../core/snapshot.js';
import { csvCell } from '../core/csv.js';
import { type ActionRequest, type Settings, type DriveApi, type FileEntry } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform === 'win32') app.setAppUserModelId('DriveWorkbench.Desktop');
let window: BrowserWindow;
if (process.env.WB_QA_DIR) app.setPath('userData', process.env.WB_QA_DIR);
// Demo data is available only with an explicitly isolated regression profile.
// WB_QA_LIVE lets regression checks exercise the real-mode UI without user data.
const demoEnabled = !!process.env.WB_QA_DIR && process.env.WB_QA_LIVE !== '1';
let mode: 'demo' | 'live' = demoEnabled ? 'demo' : 'live';
let live: SqliteStore;
let auth: AuthService;
let google: GoogleDrive;
let liveEngine: TaskEngine;
let avatars: AvatarCache;
let operations = 0;
let updater: PortableUpdater;
let updating = false;
const networkMethods = new Set([
  'list',
  'inspect',
  'permissions',
  'preview',
  'importCredentials',
  'authorize',
  'refreshAvatars',
]);
let demo: MemoryStore;
let demoDrive: DriveApi;
let demoEngine: TaskEngine;
const repo = (): Repository => (mode === 'demo' ? demo : live);
const drive = (): DriveApi => (mode === 'demo' ? demoDrive : google);
const engine = () => (mode === 'demo' ? demoEngine : liveEngine);
const dev = !app.isPackaged && process.argv.includes('--dev');
const text = (v: unknown, max = 2000) => {
  if (typeof v !== 'string' || !v || v.length > max) throw new Error('输入参数无效');
  return v;
};
const external = async (raw: string) => {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    !['drive.google.com', 'docs.google.com', 'accounts.google.com'].includes(u.hostname)
  )
    throw new Error('仅允许打开 Google 官方页面');
  await shell.openExternal(u.toString());
};
function register(name: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(`workbench:${name}`, async (event, ...args) => {
    const origin = event.senderFrame?.url || '';
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !(dev
        ? origin.startsWith('http://127.0.0.1:5173/')
        : origin === new URL('../../dist/index.html', import.meta.url).href)
    )
      throw new Error('请求来源无效');
    const tracked = networkMethods.has(name);
    if (updating && name !== 'bootstrap') throw new Error('正在准备重启更新，请稍候');
    if (tracked) operations++;
    try {
      return await handler(...args);
    } finally {
      if (tracked) operations--;
    }
  });
}
function validateRequest(r: ActionRequest) {
  if (
    !r ||
    !['share', 'transfer', 'trash', 'restore', 'rename', 'move', 'copy', 'mkdir'].includes(r.kind)
  )
    throw new Error('不支持的动作');
  text(r.accountId);
  if (r.ownerFilter !== undefined && !['all', 'mine', 'others', 'unknown'].includes(r.ownerFilter))
    throw new Error('所有者筛选无效');
  if (!Array.isArray(r.ids) || r.ids.length > 20000) throw new Error('文件列表无效');
  r.ids.forEach((x) => text(x, 256));
  if (
    typeof r.recursive !== 'boolean' ||
    (r.removeSource !== undefined && typeof r.removeSource !== 'boolean') ||
    (r.moveToTargetRoot !== undefined && typeof r.moveToTargetRoot !== 'boolean') ||
    (r.skipUntransferable !== undefined && typeof r.skipUntransferable !== 'boolean')
  )
    throw new Error('操作范围参数必须为布尔值');
  if (r.moveToTargetRoot && r.kind !== 'transfer')
    throw new Error('移至目标根目录仅用于所有权转让');
  if (r.name !== undefined) text(r.name, 255);
  if (r.destination) text(r.destination, 256);
  if (r.targetAccountId) text(r.targetAccountId, 256);
  if (r.share) {
    const s = r.share;
    for (const flag of ['notify', 'atLeast', 'removeGroups', 'removeDomains'] as const)
      if (typeof s[flag] !== 'boolean') throw new Error('分享设置布尔值无效');
    if (s.clearUsers !== undefined && typeof s.clearUsers !== 'boolean')
      throw new Error('清空协作者参数无效');
    if (
      !['keep', 'off', 'reader', 'commenter', 'writer'].includes(s.public) ||
      !['keep', 'add', 'update', 'remove', 'replace'].includes(s.collaborators)
    )
      throw new Error('权限模式无效');
    if (
      !['keep', 'yes', 'no'].includes(s.writersCanShare) ||
      !['keep', 'yes', 'no'].includes(s.copyRestriction)
    )
      throw new Error('分享设置无效');
    if (!Array.isArray(s.people) || s.people.length > 1000) throw new Error('每批最多1000个协作者');
    const check = (p: (typeof s.people)[number]) => {
      if (
        !['user', 'group', 'domain'].includes(p.type) ||
        !['reader', 'commenter', 'writer'].includes(p.role) ||
        typeof p.email !== 'string' ||
        !(
          p.type === 'domain' ? /^[a-z0-9.-]+\.[a-z]{2,}$/i : /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/
        ).test(p.email)
      )
        throw new Error(`协作者格式无效：${String(p.email).slice(0, 80)}`);
    };
    s.people.forEach(check);
    if (s.mappings) {
      if (!Array.isArray(s.mappings) || s.mappings.length > 20000) throw new Error('映射数量过多');
      s.mappings.forEach((m) => {
        text(m.fileId, 256);
        check(m.person);
      });
    }
    if (
      ['add', 'update', 'replace', 'remove'].includes(s.collaborators) &&
      !s.people.length &&
      !s.mappings?.length &&
      !(s.collaborators === 'replace' && s.clearUsers === true)
    )
      throw new Error('请填写协作者，或明确选择清空全部直接用户协作者');
  }
}
async function initialize() {
  updater = new PortableUpdater({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && app.getAppPath().endsWith('.asar'),
    appRoot:
      process.platform === 'darwin'
        ? join(dirname(app.getPath('exe')), '../..')
        : dirname(app.getPath('exe')),
    cacheDir: join(app.getPath('userData'), 'updates'),
  });
  if (demoEnabled) {
    const { DemoDrive, DEMO_ACCOUNTS } = await import('../core/demo.js');
    demo = new MemoryStore();
    demoDrive = new DemoDrive();
    for (const a of DEMO_ACCOUNTS) {
      demo.saveAccount(a);
      for (let n = 0; n < a.connections; n++)
        demo.saveConnection({
          id: randomUUID(),
          accountId: a.id,
          clientId: `演示通道 ${n + 1}`,
          clientSecret: 'demo',
          accessToken: 'demo',
          expiresAt: 0,
        });
    }
    demoEngine = new TaskEngine(demo, demoDrive);
  }
  live = new SqliteStore(
    join(app.getPath('userData'), 'workbench.sqlite'),
    (s) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，拒绝保存令牌');
      return safeStorage.encryptString(s).toString('base64');
    },
    (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  );
  auth = new AuthService(live, external);
  google = new GoogleDrive(auth);
  liveEngine = new TaskEngine(live, google);
  const makeAvatars = () =>
    new AvatarCache(
      live,
      (id) => auth.refreshProfile(id),
      (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        const size = image.getSize();
        if (image.isEmpty() || size.width > 4096 || size.height > 4096)
          throw new Error('头像内容无效');
        return image.resize({ width: 96, height: 96, quality: 'best' }).toDataURL();
      },
    );
  avatars = makeAvatars();
  const syncAvatars = async (force = false) => {
    let updated = 0,
      unavailable = 0;
    for (const account of live.accounts()) {
      const result = await avatars.refresh(account.id, force);
      if (result === 'updated') updated++;
      if (result === 'unavailable') unavailable++;
    }
    return `头像已更新 ${updated} 个${unavailable ? `，${unavailable} 个暂不可用，保留缓存或首字母头像` : ''}`;
  };
  const backgroundAvatars = () => {
    operations++;
    void syncAvatars()
      .catch(() => {})
      .finally(() => operations--);
  };
  const ensureIdle = () => {
    if (operations || engine().maintenanceBusy)
      throw new Error('请先结束扫描、授权等操作，并暂停任务、等待在途请求结束');
  };
  if (live.accounts().length) mode = 'live';
  register('bootstrap', () => ({
    update: { ...updater.state },
    mode,
    demoEnabled,
    accounts: repo().accounts(),
    tasks: repo().taskSummaries(),
    settings: repo().settings(),
    runtime: mode === 'live' ? auth.snapshot() : { accounts: [], projects: [] },
    connections: repo()
      .connections()
      .map((c) => ({
        id: c.id,
        accountId: c.accountId,
        clientId: c.clientId,
        ready: !!c.accountId && !c.disabled,
        error: c.error,
      })),
  }));
  register(
    'list',
    (
      a: string,
      p: string,
      recursive = false,
      trashed = false,
      requestId?: string,
      maxDepth?: number,
    ) => {
      if (
        maxDepth !== undefined &&
        (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1000)
      )
        throw new Error('最大扫描层级须为1到1000的整数');
      return drive().list(
        text(a),
        text(p),
        !!recursive,
        !!trashed,
        (progress) => {
          if (requestId)
            window.webContents.send('workbench:scanProgress', { ...progress, requestId });
        },
        maxDepth,
      );
    },
  );
  register('task', (id: string) => {
    const t = repo()
      .tasks()
      .find((t) => t.id === text(id));
    if (!t) throw new Error('任务不存在');
    return { ...t, api: t.items.some((i) => i.api) ? sumCounters(t.items) : undefined };
  });
  register('deleteTasks', (ids: string[]) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000) throw new Error('任务列表无效');
    return engine().deleteTasks([...new Set(ids.map((id) => text(id)))]);
  });
  register('removeAccount', (id: string) => {
    ensureIdle();
    id = text(id);
    if (
      !repo()
        .accounts()
        .some((a) => a.id === id)
    )
      throw new Error('账号不存在');
    engine().forgetAccount(id);
    repo().deleteAccount(id);
  });
  register('resetLocalData', (confirmation: string) => {
    if (confirmation !== '清空本地数据') throw new Error('请输入“清空本地数据”以确认');
    ensureIdle();
    engine().reset();
    if (mode === 'live') {
      auth = new AuthService(live, external);
      google = new GoogleDrive(auth);
      liveEngine = new TaskEngine(live, google);
      avatars = makeAvatars();
    }
  });
  register('checkUpdate', () => updater.check());
  register('installUpdate', async () => {
    ensureIdle();
    updating = true;
    try {
      const helper = await updater.prepareInstall(process.pid);
      const child = spawn(helper.command, helper.args, {
        cwd: helper.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      app.quit();
    } catch (e) {
      updating = false;
      if (updater.state.status === 'installing') updater.state.status = 'ready';
      throw e;
    }
  });
  register('refreshAvatars', () => {
    if (mode !== 'live') throw new Error('演示账号不获取 Google 头像');
    return syncAvatars(true);
  });
  register('inspect', (a: string, id: string, key?: string) => {
    text(id, 256);
    if (key && mode === 'live') google.registerKey(id, text(key, 512));
    return drive().get(text(a), id);
  });
  register('copyLinks', (links: string[]) => {
    if (!Array.isArray(links) || links.length > 100000) throw new Error('链接列表无效');
    const values = links.map((raw) => {
      const u = new URL(text(raw));
      if (u.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(u.hostname))
        throw new Error('仅支持 Google 文件链接');
      return u.toString();
    });
    clipboard.writeText(values.join('\n'));
  });
  register('permissions', (a: string, id: string) => drive().permissions(text(a), text(id, 256)));
  register('preview', (r: ActionRequest) => {
    validateRequest(r);
    return engine().preview(r);
  });
  register('submit', (id: string) => engine().submit(text(id)));
  register('control', (id: string, action: 'pause' | 'resume' | 'retry') => {
    if (!['pause', 'resume', 'retry'].includes(action)) throw new Error('无效控制动作');
    return engine().control(text(id), action);
  });
  register('settings', (s: Settings) => {
    for (const [k, max] of [
      ['accountConcurrency', 18],
      ['connectionConcurrency', 6],
    ] as const)
      if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > max) throw new Error('并发值超出范围');
    repo().saveSettings(s);
  });
  register('switchMode', (m: string) => {
    if (m !== 'demo' && m !== 'live') throw new Error('无效模式');
    if (m === 'demo' && !demoEnabled) throw new Error('正式运行不提供演示模式');
    if (engine().active) throw new Error('请先完成当前模式的任务，再切换模式');
    mode = m;
  });
  register('importCredentials', async () => {
    if (mode === 'demo' && demoEngine.active) throw new Error('请等待演示任务完成，再切换真实账号');
    const result = await dialog.showOpenDialog(window, {
      title: '导入桌面 OAuth 配置或 token.json',
      filters: [{ name: 'Google OAuth JSON', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return '已取消';
    let count = 0;
    for (const path of result.filePaths) {
      const raw = await readFile(path, 'utf8');
      if (raw.length > 1024 * 1024) throw new Error('授权文件过大');
      await auth.importJson(raw);
      count++;
    }
    mode = 'live';
    backgroundAvatars();
    return `已导入 ${count} 份配置，请在连接列表完成授权`;
  });
  register('authorize', async (id: string) => {
    if (mode !== 'live') throw new Error('请切换真实账号模式');
    const result = await auth.authorize(text(id));
    backgroundAvatars();
    return result;
  });
  register('disconnect', (id: string) => {
    if (mode !== 'live') throw new Error('演示连接无需移除');
    ensureIdle();
    live.deleteConnection(text(id));
  });
  register(
    'exportSnapshot',
    async (
      a: string,
      files: FileEntry[],
      complete: boolean,
      rootId?: string,
      maxDepth?: number,
    ) => {
      text(a);
      if (!Array.isArray(files) || files.length > 100000) throw new Error('目录数据无效');
      const output = await dialog.showSaveDialog(window, {
        defaultPath: '网盘目录快照.html',
        filters: [
          { name: 'HTML 交互目录', extensions: ['html'] },
          { name: 'CSV 完整明细', extensions: ['csv'] },
        ],
      });
      if (output.canceled || !output.filePath) return '已取消';
      const csv = output.filePath.toLowerCase().endsWith('.csv');
      await writeFile(
        output.filePath,
        csv
          ? snapshotCsv(files, rootId)
          : snapshotHtml(
              files,
              maxDepth
                ? `网盘目录快照 · 最多${maxDepth}层，仅含已扫描部分`
                : complete
                  ? '网盘目录快照'
                  : '网盘目录快照 · 扫描不完整',
              rootId,
            ),
        'utf8',
      );
      return '交互快照已导出';
    },
  );
  register('exportReport', async (id: string) => {
    const t = repo()
      .tasks()
      .find((t) => t.id === text(id));
    if (!t) throw new Error('任务不存在');
    const result = await dialog.showSaveDialog(window, {
      defaultPath: `任务报告-${t.id.slice(0, 8)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return '已取消';
    const rows = [
      [
        '文件名称',
        '文件ID',
        '状态',
        '结果',
        '错误',
        '尝试次数',
        'API读取',
        'API写入',
        '重试复查',
        '限流次数',
        '阶段及暂停历史',
      ],
      ...t.items.map((i) => [
        i.file.name,
        i.file.id,
        i.state,
        i.result,
        i.error,
        i.attempts,
        i.api?.reads || 0,
        i.api?.writes || 0,
        i.api?.retries || 0,
        i.api?.rateLimits || 0,
        i.history?.map((e) => `${e.time} [${e.kind}] ${e.message}`).join('；'),
      ]),
    ];
    await writeFile(
      result.filePath,
      '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'),
      'utf8',
    );
    return '任务报告已导出';
  });
  register('openExternal', (url: string) => external(text(url)));
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1050,
    minHeight: 720,
    show: !process.env.WB_QA_DIR,
    backgroundColor: '#f7f8fa',
    title: '云盘工作台',
    icon: join(here, '../../dist/app-icon.png'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // This application needs no browser device, notification or geolocation permissions.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (e, url) => {
    if (url !== window.webContents.getURL()) e.preventDefault();
  });
  if (dev) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(join(here, '../../dist/index.html'));
  if (mode === 'live' && !process.env.WB_QA_DIR) backgroundAvatars();
  if (!process.env.WB_QA_DIR) void updater.check();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(initialize)
    .catch((e) => {
      dialog.showErrorBox('启动失败', String(e));
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (live) live.close();
});
