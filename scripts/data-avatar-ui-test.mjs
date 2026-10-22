// All accounts, tokens, images and HTTP responses below are isolated test fixtures.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(tmpdir(), 'drive-data-avatar-'));
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const report = path.resolve(
  'test-results',
  executablePath ? 'data-avatar-packaged' : 'data-avatar',
);
await mkdir(report, { recursive: true });
const env = { ...process.env, WB_QA_DIR: profile, WB_QA_LIVE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const launch = async () => {
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : { args: ['.'] }),
    env,
    timeout: 45000,
  });
  await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  return application;
};
let app;
const errors = [],
  checks = [];
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
try {
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByText('连接你的第一个账号', { exact: true }).waitFor();
  await app.evaluate(({ app, safeStorage, nativeImage }) => {
    const path = process.getBuiltinModule('node:path');
    const require = process
      .getBuiltinModule('node:module')
      .createRequire(path.join(app.getAppPath(), 'package.json'));
    const { SqliteStore } = require(path.join(app.getAppPath(), 'dist-desktop/core/store.js'));
    const store = new SqliteStore(
      path.join(app.getPath('userData'), 'workbench.sqlite'),
      (s) => safeStorage.encryptString(s).toString('base64'),
      (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
    );
    for (const id of ['a', 'b']) {
      store.saveAccount({
        id,
        permissionId: id,
        email: `${id}@example.com`,
        name: id.toUpperCase(),
        connections: 1,
        ready: true,
      });
      store.saveConnection({
        id: `c-${id}`,
        accountId: id,
        clientId: `fixture-${id}`,
        clientSecret: 'fixture',
        accessToken: `token-${id}`,
        expiresAt: Date.now() + 3600000,
      });
    }
    for (const [id, status] of [
      ['done-1', 'completed'],
      ['done-2', 'partial'],
      ['paused', 'paused'],
      ['running', 'running'],
    ])
      store.saveTask({
        id,
        title: id,
        request: { accountId: 'a', kind: 'rename', ids: ['file'], recursive: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status,
        paused: status === 'paused',
        items: [
          {
            file: { id: 'file', name: 'file', parents: [], mimeType: 'text/plain' },
            changes: [],
            mutations: [],
            state: status === 'paused' ? 'unknown' : 'succeeded',
            attempts: 1,
            history: [{ time: 'now', kind: 'test', message: 'isolated log' }],
            api: { reads: 1, writes: 1, retries: 0, rateLimits: 0 },
          },
        ],
      });
    store.close();
    globalThis.qaCalls = [];
    const image = nativeImage
      .createFromPath(path.join(app.getAppPath(), 'dist/app-icon.png'))
      .toPNG();
    globalThis.fetch = async (raw, options = {}) => {
      const url = String(raw);
      globalThis.qaCalls.push({ url, authorization: options.headers?.Authorization });
      if (url.includes('/drive/v3/about')) {
        const id = options.headers.Authorization === 'Bearer token-a' ? 'a' : 'b';
        return new Response(
          JSON.stringify({
            user: {
              permissionId: id,
              emailAddress: `${id}@example.com`,
              displayName: id.toUpperCase(),
              ...(id === 'a' ? { photoLink: 'https://lh3.googleusercontent.com/fixture' } : {}),
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://lh3.googleusercontent.com/fixture') {
        if (globalThis.qaHold) await new Promise((r) => (globalThis.qaRelease = r));
        return new Response(image, { headers: { 'content-type': 'image/png' } });
      }
      if (url.includes('/drive/v3/files/root?'))
        return new Response(
          JSON.stringify({
            id: 'root',
            name: 'Root',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            capabilities: { canListChildren: true },
          }),
        );
      if (url.includes('/drive/v3/files?'))
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'file',
                name: 'fixture-file',
                mimeType: 'text/plain',
                parents: ['root'],
                ownedByMe: true,
              },
            ],
          }),
        );
      throw Error('Unexpected test network request: ' + url);
    };
  });
  await page.locator('.account-item[title="a@example.com"]').waitFor();
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 fixture-file', exact: true }).waitFor();
  await page.getByRole('button', { name: '清空扫描', exact: true }).click();
  assert(
    (await page.getByRole('checkbox', { name: '选择 fixture-file', exact: true }).count()) === 0,
    'Scan not cleared',
  );
  await page.locator('.account-item[title="b@example.com"]').click();
  await page.locator('.account-item[title="a@example.com"]').click();
  assert(
    (await page.getByRole('checkbox', { name: '选择 fixture-file', exact: true }).count()) === 0,
    'Scan restored after clear',
  );
  checks.push('scan cleared without remote writes and stays cleared after account switches');
  for (const id of ['b', 'a']) {
    await page.locator(`.account-item[title="${id}@example.com"]`).click();
    await page.getByRole('button', { name: '扫描', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择 fixture-file', exact: true }).waitFor();
  }
  const beforeClear = await app.evaluate(() => globalThis.qaCalls.length);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '数据与记录管理', exact: true }).click();
  const scanData = page.getByRole('dialog', { name: '数据与记录管理', exact: true });
  await scanData.getByRole('button', { name: '清空扫描结果', exact: true }).click();
  await scanData.getByRole('button', { name: '关闭', exact: true }).click();
  for (const id of ['b', 'a']) {
    await page.locator(`.account-item[title="${id}@example.com"]`).click();
    assert(
      (await page.getByRole('checkbox', { name: '选择 fixture-file', exact: true }).count()) === 0,
      'Other account scan was not cleared',
    );
  }
  assert(
    (await app.evaluate(() => globalThis.qaCalls.length)) === beforeClear,
    'Cleanup made remote requests',
  );
  checks.push('all account scans cleared with zero remote requests');

  await page
    .getByRole('button', { name: /任务记录/ })
    .first()
    .click();
  const tasks = page.getByRole('dialog', { name: '任务记录', exact: true });
  const paused = tasks
    .locator('.task-card')
    .filter({ has: page.getByRole('heading', { name: 'paused', exact: true }) });
  const running = tasks
    .locator('.task-card')
    .filter({ has: page.getByRole('heading', { name: 'running', exact: true }) });
  assert(
    await running.getByTitle('删除本地任务记录', { exact: true }).isDisabled(),
    'Running task delete enabled',
  );
  let rejection = await page.evaluate(async () => {
    try {
      await window.workbench.deleteTasks(['done-1', 'running']);
      return '';
    } catch (e) {
      return e.message;
    }
  });
  assert(rejection.includes('仍在执行'), 'Running task backend protection missing');
  await paused.getByTitle('删除本地任务记录', { exact: true }).click();
  let confirm = page.getByRole('dialog', { name: '删除本地任务记录', exact: true });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  assert(
    (await page.evaluate(() => window.workbench.bootstrap())).tasks.length === 4,
    'Cancel removed task',
  );
  await paused.getByTitle('删除本地任务记录', { exact: true }).click();
  await confirm.getByRole('button', { name: '确认删除本地数据', exact: true }).click();
  await paused.waitFor({ state: 'detached' });
  await tasks.getByRole('button', { name: '清理已结束任务', exact: true }).click();
  await confirm.getByRole('button', { name: '确认删除本地数据', exact: true }).click();
  await tasks.getByRole('heading', { name: 'done-1', exact: true }).waitFor({ state: 'detached' });
  let boot = await page.evaluate(() => window.workbench.bootstrap());
  assert(boot.tasks.length === 1 && boot.tasks[0].id === 'running', 'Bulk cleanup scope incorrect');
  checks.push('single deletion, cancel, batch terminal cleanup, running task rejection');
  await tasks.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '数据与记录管理', exact: true }).click();
  let data = page.getByRole('dialog', { name: '数据与记录管理', exact: true });
  await data.getByRole('button', { name: '刷新账号头像', exact: true }).click();
  const avatar = page
    .locator('.accounts-rail')
    .getByRole('img', { name: 'a@example.com 的头像', exact: true });
  await avatar.waitFor();
  assert(
    await avatar.evaluate(
      (img) =>
        img.complete && img.naturalWidth === 96 && img.src.startsWith('data:image/png;base64,'),
    ),
    'Avatar is not local resized PNG',
  );
  assert(
    (await page.getByRole('img', { name: 'b@example.com 的头像', exact: true }).count()) === 0,
    'No-photo account has image',
  );
  const calls = await app.evaluate(() => globalThis.qaCalls);
  assert(calls.filter((c) => c.url.includes('/about')).length === 2, 'Unexpected profile calls');
  assert(
    calls.filter((c) => c.url.includes('googleusercontent')).length === 1,
    'Unexpected image calls',
  );
  assert(
    calls.filter((c) => c.url.includes('googleusercontent')).every((c) => !c.authorization),
    'OAuth sent to image host',
  );
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.screenshot({ path: path.join(report, '01-data-avatar.png') });
  assert(
    !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
    'Small layout overflows',
  );
  await avatar.dispatchEvent('error');
  await avatar.waitFor({ state: 'detached' });
  checks.push(
    'real adapter reads photoLink, local 96px image, missing/error fallback, no image OAuth, 1050px layout',
  );

  await app.evaluate(() => {
    globalThis.qaHold = true;
  });
  await page.evaluate(() => {
    window.qaAvatarPromise = window.workbench.refreshAvatars();
  });
  for (let i = 0; i < 100 && !(await app.evaluate(() => !!globalThis.qaRelease)); i++)
    await new Promise((r) => setTimeout(r, 20));
  rejection = await page.evaluate(async () => {
    try {
      await window.workbench.resetLocalData('清空本地数据');
      return '';
    } catch (e) {
      return e.message;
    }
  });
  assert(rejection.includes('在途'), 'Reset allowed during avatar operation');
  await app.evaluate(() => {
    globalThis.qaHold = false;
    globalThis.qaRelease();
  });
  await page.evaluate(() => window.qaAvatarPromise);
  checks.push('reset blocked while network operation is in flight');

  await app.close();
  app = await launch();
  const restored = await app.firstWindow();
  restored.setDefaultTimeout(12000);
  restored.on('pageerror', (e) => errors.push(e.message));
  await restored.getByRole('img', { name: 'a@example.com 的头像', exact: true }).waitFor();
  boot = await restored.evaluate(() => window.workbench.bootstrap());
  assert(
    boot.tasks.length === 1 && boot.accounts[0].avatar.startsWith('data:'),
    'Deletion or cached avatar lost across restart',
  );
  checks.push('deleted task stays deleted; encrypted connections and avatar survive restart');
  await restored.getByRole('button', { name: '设置', exact: true }).click();
  await restored.getByRole('button', { name: '数据与记录管理', exact: true }).click();
  data = restored.getByRole('dialog', { name: '数据与记录管理', exact: true });
  await data
    .locator('.data-action-row')
    .filter({ hasText: 'a@example.com' })
    .getByRole('button', { name: '移除账号', exact: true })
    .click();
  await restored
    .getByRole('dialog', { name: '移除本地账号', exact: true })
    .getByRole('button', { name: '确认删除本地数据', exact: true })
    .click();
  await data.getByText('a@example.com', { exact: true }).waitFor({ state: 'detached' });
  boot = await restored.evaluate(() => window.workbench.bootstrap());
  assert(
    boot.accounts.length === 1 && boot.connections.length === 1 && boot.tasks.length === 1,
    'Remove account scope incorrect',
  );
  await data.getByRole('button', { name: '重置本地数据', exact: true }).click();
  confirm = restored.getByRole('dialog', { name: '确认重置本地数据', exact: true });
  assert(
    await confirm.getByRole('button', { name: '确认删除本地数据', exact: true }).isDisabled(),
    'Reset allowed without phrase',
  );
  rejection = await restored.evaluate(async () => {
    try {
      await window.workbench.resetLocalData('wrong');
      return '';
    } catch (e) {
      return e.message;
    }
  });
  assert(rejection.includes('确认'), 'Backend reset phrase missing');
  await confirm.getByLabel('重置确认文字').fill('清空本地数据');
  await restored.screenshot({ path: path.join(report, '02-reset-confirmation.png') });
  await confirm.getByRole('button', { name: '确认删除本地数据', exact: true }).click();
  await restored.getByText('连接你的第一个账号', { exact: true }).waitFor();
  boot = await restored.evaluate(() => window.workbench.bootstrap());
  assert(
    !boot.accounts.length &&
      !boot.connections.length &&
      !boot.tasks.length &&
      boot.settings.accountConcurrency === 18,
    'Reset incomplete',
  );
  await app.close();
  app = await launch();
  const empty = await app.firstWindow();
  await empty.getByText('连接你的第一个账号', { exact: true }).waitFor();
  boot = await empty.evaluate(() => window.workbench.bootstrap());
  assert(
    !boot.accounts.length && !boot.connections.length && !boot.tasks.length,
    'Reset data resurrected',
  );
  checks.push(
    'account removes only own local authorization; typed reset clears all local records and persists',
  );
  assert(errors.length === 0, errors.join('\n'));
  await writeFile(
    path.join(report, 'results.json'),
    JSON.stringify({ passed: true, checks, errors, profile }, null, 2),
  );
  console.log('Data/avatar UI passed:', checks.join('; '));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(report, 'failure.png') }).catch(() => {});
    await writeFile(
      path.join(report, 'failure.txt'),
      (await page.locator('body').innerText()) + '\n' + String(error),
    );
  }
  throw error;
} finally {
  if (app) await app.close();
}
