// Exercises the normal live-only UI using a temporary profile and fake OAuth
// configuration. OAuth cancellation uses only the local callback server.
import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(tmpdir(), 'drive-production-'));
const env = { ...process.env, WB_QA_DIR: profile, WB_QA_LIVE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const launch = () =>
  electron.launch({
    ...(executablePath ? { executablePath } : { args: ['.'] }),
    env,
    timeout: 45000,
  });
const reportDir = path.resolve(
  'test-results',
  executablePath ? 'production-packaged' : 'production',
);
await mkdir(reportDir, { recursive: true });
const configPath = path.join(profile, 'credentials.json'),
  badPath = path.join(profile, 'invalid.json');
await writeFile(
  configPath,
  JSON.stringify({
    installed: { client_id: 'qa-no-network.apps.googleusercontent.com', client_secret: 'qa-only' },
  }),
);
await writeFile(badPath, JSON.stringify({ web: { client_id: 'wrong-type' } }));
const errors = [],
  checks = [];
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  page.setDefaultTimeout(12000);
  const captureErrors = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  };
  captureErrors(page);
  await page.getByText('连接你的第一个账号', { exact: true }).waitFor();
  let boot = await page.evaluate(() => window.workbench.bootstrap());
  if (boot.mode !== 'live' || boot.demoEnabled || boot.accounts.length || boot.tasks.length)
    throw Error('Normal first launch contains demo data');
  if (!(await page.getByRole('button', { name: '扫描', exact: true }).isDisabled()))
    throw Error('Scan enabled without account');
  if (await page.getByText('演示', { exact: true }).count()) throw Error('Demo badge visible');
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.screenshot({ path: path.join(reportDir, '01-first-launch.png') });
  await page
    .locator('.empty-state')
    .getByRole('button', { name: '账号与授权', exact: true })
    .click();
  const dialog = () => page.getByRole('dialog', { name: '账号与授权连接', exact: true });
  if (
    await dialog()
      .getByRole('button', { name: /切换至/ })
      .count()
  )
    throw Error('Mode switch visible in production');
  const rejected = await page.evaluate(async () => {
    try {
      await window.workbench.switchMode('demo');
      return false;
    } catch {
      return true;
    }
  });
  if (!rejected) throw Error('Hidden demo mode accessible through IPC');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await dialog().getByRole('button', { name: '导入授权文件', exact: true }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, badPath);
  await dialog().getByRole('button', { name: '导入授权文件', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: '请使用 Desktop app 类型的 installed OAuth 配置' })
    .waitFor();
  if ((await page.evaluate(() => window.workbench.bootstrap())).connections.length)
    throw Error('Invalid config was persisted');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, configPath);
  await dialog().getByRole('button', { name: '导入授权文件', exact: true }).click();
  await dialog().getByText('尚未绑定 Gmail', { exact: true }).waitFor();
  await app.evaluate(({ shell }) => {
    globalThis.qaAuthOpenCount = 0;
    globalThis.qaUnexpectedRemoteRequests = [];
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, ...args) => {
      if (!String(url).startsWith('http://127.0.0.1:')) {
        globalThis.qaUnexpectedRemoteRequests.push(new URL(String(url)).hostname);
        throw Error('Production regression must not make remote network requests');
      }
      return nativeFetch(url, ...args);
    };
    shell.openExternal = async (raw) => {
      const url = new URL(raw);
      if (url.origin !== 'https://accounts.google.com')
        throw Error('Unexpected authorization destination');
      globalThis.qaAuthOpenCount++;
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('error', 'access_denied');
      setTimeout(() => void nativeFetch(callback).catch(() => {}), 30);
    };
  });
  await dialog().getByRole('button', { name: '浏览器授权', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '授权被取消或拒绝' }).waitFor();
  boot = await page.evaluate(() => window.workbench.bootstrap());
  if (
    boot.mode !== 'live' ||
    boot.accounts.length ||
    boot.connections.length !== 1 ||
    boot.connections[0].ready
  )
    throw Error('Canceled authorization created a fake identity');
  const calls = await app.evaluate(() => ({
    auth: globalThis.qaAuthOpenCount,
    remote: globalThis.qaUnexpectedRemoteRequests,
  }));
  if (calls.auth !== 1 || calls.remote.length)
    throw Error('Authorization cancellation attempted remote access');
  await page.screenshot({ path: path.join(reportDir, '02-authorization.png') });
  await dialog().getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByText('完成 Google 账号授权', { exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('spinbutton', { name: '每账号并发上限', exact: true }).fill('12');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('执行设置已保存', { exact: true }).waitFor();
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  if (path.resolve(userData) !== path.resolve(profile))
    throw Error('Test escaped isolated profile');
  await app.close();
  app = undefined;
  // Seed a synthetic saved identity and interrupted task, never the user's database.
  const db = new DatabaseSync(path.join(profile, 'workbench.sqlite'));
  const account = {
    id: 'qa-saved',
    permissionId: 'qa-saved',
    email: 'saved@example.com',
    name: '已保存账号',
    ready: false,
    connections: 0,
  };
  const task = {
    id: 'qa-interrupted',
    title: '中断恢复验证',
    request: {
      kind: 'rename',
      accountId: account.id,
      ids: ['qa-file'],
      recursive: false,
      name: 'after',
    },
    status: 'running',
    paused: false,
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    items: [],
  };
  const item = {
    file: { id: 'qa-file', name: 'before', mimeType: 'text/plain', parents: ['root'] },
    state: 'running',
    attempts: 1,
    mutations: [],
    changes: ['重命名'],
  };
  const insert = db.prepare('INSERT INTO records(kind,id,body) VALUES (?,?,?)');
  insert.run('account', account.id, JSON.stringify(account));
  insert.run('task', task.id, JSON.stringify(task));
  db.prepare('INSERT INTO task_items(task_id,file_id,state,body) VALUES (?,?,?,?)').run(
    task.id,
    item.file.id,
    item.state,
    JSON.stringify(item),
  );
  db.close();
  const encrypted = await readFile(path.join(profile, 'workbench.sqlite'));
  if (encrypted.includes(Buffer.from('qa-only'))) throw Error('OAuth secret stored in plaintext');
  app = await launch();
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  page.setDefaultTimeout(12000);
  captureErrors(page);
  await page
    .getByRole('navigation', { name: 'Google 账号', exact: true })
    .getByText('已保存账号', { exact: true })
    .waitFor();
  boot = await page.evaluate(() => window.workbench.bootstrap());
  const restored = await page.evaluate(() => window.workbench.task('qa-interrupted'));
  if (
    boot.mode !== 'live' ||
    boot.demoEnabled ||
    boot.accounts.length !== 1 ||
    boot.connections.length !== 1 ||
    boot.settings.accountConcurrency !== 12
  )
    throw Error('Saved live profile not restored');
  if (restored.status !== 'paused' || !restored.paused || restored.items[0].state !== 'unknown')
    throw Error('Interrupted task resumed automatically');
  await page.getByRole('button', { name: '账号与授权', exact: true }).click();
  await dialog().getByText('尚未绑定 Gmail', { exact: true }).waitFor();
  if (
    await dialog()
      .getByRole('button', { name: /切换至/ })
      .count()
  )
    throw Error('Demo switch appeared after restart');
  await page.screenshot({ path: path.join(reportDir, '03-restored-profile.png') });
  checks.push(
    'normal live-only first launch without sample accounts',
    'first-run and pending-authorization guidance',
    'demo hidden in UI and rejected by IPC',
    'canceled and invalid imports do not corrupt state',
    'valid Desktop OAuth config encrypted and persisted',
    'authorization entry and cancellation through actual local callback',
    'no remote requests during authorization cancellation',
    'saved identity, connection and settings restored',
    'interrupted task paused/unknown after restart',
    'temporary user profile verified',
    'no console errors',
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    path.join(reportDir, 'results.json'),
    JSON.stringify(
      { passed: true, checks, errors, executable: executablePath || 'source build' },
      null,
      2,
    ),
  );
  console.log('Production UI passed:', checks.join('; '));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(reportDir, '99-failure.png') });
    console.error((await page.locator('body').innerText()).slice(-2500));
  }
  throw error;
} finally {
  if (app) await app.close();
}
