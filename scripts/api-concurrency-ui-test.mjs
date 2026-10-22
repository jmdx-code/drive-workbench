import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../dist-desktop/core/store.js';
const profile = await mkdtemp(path.join(tmpdir(), 'drive-api-concurrency-'));
const env = { ...process.env, WB_QA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const report = process.argv[2]
  ? 'test-results/api-concurrency-packaged'
  : 'test-results/api-concurrency';
await mkdir(report, { recursive: true });
const app = await electron.launch({
  ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : { args: ['.'] }),
  env,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    const require = process
      .getBuiltinModule('node:module')
      .createRequire(app.getAppPath() + '/package.json');
    const path = require('node:path');
    const { DemoDrive } = require(path.join(app.getAppPath(), 'dist-desktop/core/demo.js'));
    const { apiEvent } = require(path.join(app.getAppPath(), 'dist-desktop/core/telemetry.js'));
    let lag = true,
      hidden = true;
    for (const method of [
      'get',
      'permissions',
      'createPermission',
      'updatePermission',
      'deletePermission',
      'update',
    ]) {
      const original = DemoDrive.prototype[method];
      DemoDrive.prototype[method] = async function (...args) {
        apiEvent({
          type: 'request',
          method: ['get', 'permissions'].includes(method) ? 'GET' : 'PATCH',
        });
        if (method === 'updatePermission' && args[1] === 'plan' && args[4] && lag) {
          lag = false;
          throw Object.assign(new Error('模拟权限传播延迟'), { status: 403 });
        }
        const result = await original.apply(this, args);
        if (method === 'permissions' && args[0] === 'demo-work' && args[1] === 'plan' && hidden) {
          hidden = false;
          return [];
        }
        return result;
      };
    }
    const original = ipcMain._invokeHandlers.get('workbench:bootstrap');
    ipcMain.removeHandler('workbench:bootstrap');
    ipcMain.handle('workbench:bootstrap', async (...args) => {
      const value = await original(...args);
      value.runtime = {
        projects: [],
        accounts: [
          {
            accountId: 'demo-lin',
            active: 3,
            limit: 9,
            ceiling: 18,
            waitingMs: 2500,
            requestsPerMinute: 30,
            reason: 'userRateLimitExceeded',
          },
        ],
      };
      return value;
    });
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: path.join(app.getPath('userData'), 'api-report.csv'),
    });
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '并发与执行设置' });
  if (await settings.getByRole('spinbutton', { name: '全局并发上限', exact: true }).count())
    throw Error('Global cap still visible');
  const account = settings.getByRole('spinbutton', { name: '每账号并发上限', exact: true });
  const connection = settings.getByRole('spinbutton', { name: '每授权连接并发上限', exact: true });
  if ((await account.inputValue()) !== '18' || (await connection.inputValue()) !== '6')
    throw Error('Incorrect defaults');
  if (
    (await account.getAttribute('max')) !== '18' ||
    (await connection.getAttribute('max')) !== '6'
  )
    throw Error('Incorrect maximums');
  await settings.getByText(/当前并发 3\/9/).waitFor();
  await account.fill('19');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '并发值超出范围' }).waitFor();
  await page.getByRole('status').getByRole('button').click();
  await account.fill('18');
  await connection.fill('6');
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.screenshot({ path: `${report}/01-settings.png` });
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '包含文件夹内后代（仍按当前所有者范围筛选）', exact: true })
    .check();
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByRole('button', { name: /确认执行 \d+ 项/ }).click();
  const records = page.getByRole('dialog', { name: '任务记录', exact: true });
  await records.getByText('已完成', { exact: true }).waitFor();
  const task = await page.evaluate(async () => {
    const boot = await window.workbench.bootstrap();
    return window.workbench.task(boot.tasks[0].id);
  });
  if (
    !task.api ||
    task.api.reads === 0 ||
    task.api.writes === 0 ||
    task.api.retries === 0 ||
    task.items.some((i) => i.attempts !== 1)
  )
    throw Error('Request metrics/automatic continuation failed');
  await records.getByText(/API 读取/).waitFor();
  await page.screenshot({ path: `${report}/02-metrics.png` });
  await records.getByRole('button', { name: '查看明细', exact: true }).click();
  const detail = page.getByRole('dialog').last();
  await detail
    .getByText(/阶段与暂停历史/)
    .first()
    .click();
  await page.screenshot({ path: `${report}/03-history.png` });
  await detail.getByRole('button', { name: '导出明细', exact: true }).click();
  const csv = await readFile(path.join(profile, 'api-report.csv'), 'utf8');
  if (
    !csv.includes('API读取') ||
    !csv.includes('阶段及暂停历史') ||
    !csv.includes('等待 Google 同步权限状态')
  )
    throw Error('CSV lacks metrics/history');
  const dbPath = path.join(profile, 'metrics.sqlite');
  let sql = new SqliteStore(
    dbPath,
    (s) => s,
    (s) => s,
  );
  sql.saveTask(task, task.items);
  sql.close();
  sql = new SqliteStore(
    dbPath,
    (s) => s,
    (s) => s,
  );
  if (
    JSON.stringify(sql.taskSummaries()[0].api) !== JSON.stringify(task.api) ||
    !sql.tasks()[0].items.some((i) => i.history?.some((e) => e.kind === 'waiting'))
  )
    throw Error('SQLite metrics/history roundtrip failed');
  sql.close();
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    `${report}/results.json`,
    JSON.stringify(
      {
        passed: true,
        checks: [
          '18/6 defaults and validation',
          'global cap removed',
          'effective concurrency and cooling visible',
          'propagation auto recheck without task restart',
          'per-task request metrics',
          'stage/history UI and CSV',
          'SQLite persistent counters and history',
          '1050x720 layout',
          'console clean',
        ],
        task,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('API/concurrency UI passed');
} finally {
  await app.close();
}
