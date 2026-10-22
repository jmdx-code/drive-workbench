import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(tmpdir(), 'drive-skip-transfer-'));
const env = { ...process.env, WB_QA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const reportDir = process.argv[2]
  ? 'test-results/skip-transfer-packaged'
  : 'test-results/skip-transfer';
await mkdir(reportDir, { recursive: true });
const app = await electron.launch({
  ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : { args: ['.'] }),
  env,
});
const errors = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  // Isolated demo fixture: one nested file belongs to an unrelated third party.
  await app.evaluate(async ({ app, BrowserWindow, dialog }) => {
    const require = process
      .getBuiltinModule('node:module')
      .createRequire(app.getAppPath() + '/package.json');
    const path = require('node:path');
    const { DemoDrive } = require(path.join(app.getAppPath(), 'dist-desktop/core/demo.js'));
    const get = DemoDrive.prototype.get,
      list = DemoDrive.prototype.list;
    const foreign = (f) =>
      f.id === 'plan'
        ? { ...f, ownedByMe: false, owners: [{ emailAddress: 'third@example.com' }] }
        : f;
    DemoDrive.prototype.get = async function (...args) {
      return foreign(await get.apply(this, args));
    };
    DemoDrive.prototype.list = async function (...args) {
      const r = await list.apply(this, args);
      return { ...r, files: r.files.map(foreign) };
    };
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: path.join(app.getPath('userData'), 'skip-report.csv'),
    });
    BrowserWindow.getAllWindows()[0].showInactive();
  });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  const move = page.getByRole('checkbox', {
    name: '转让后移到目标账号的“我的云端硬盘”根目录',
    exact: true,
  });
  const skip = page.getByRole('checkbox', {
    name: '跳过不可转让的子项，继续移动父文件夹',
    exact: true,
  });
  await move.check();
  await page
    .getByRole('checkbox', { name: '包含文件夹内后代（仍按当前所有者范围筛选）', exact: true })
    .check();
  if (await skip.count()) throw Error('Obsolete mode switch is still visible');
  await page.getByText(/尽量完成：自动跳过/).waitFor();
  for (const width of [1050, 760]) {
    await page.setViewportSize({ width, height: 720 });
    const footer = await page.locator('.modal-footer').boundingBox();
    if (!footer || footer.y < 0 || footer.y + footer.height > 720)
      throw Error('Unreachable footer at ' + width);
    await page.screenshot({ path: `${reportDir}/option-${width}.png` });
  }
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByText('1 项将跳过', { exact: true }).waitFor();
  await page
    .getByRole('alert')
    .filter({ hasText: '当前文件夹中有 1 个项目的所有者不是你' })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByText('当前所有者：third@example.com', { exact: true })
    .waitFor();
  const before = await page.evaluate(async () => window.workbench.inspect('demo-lin', 'projects'));
  if (!before.ownedByMe) throw Error('Preview modified ownership before confirmation');
  await page
    .getByRole('dialog')
    .getByText(/跳过所有权转让：/)
    .waitFor();
  await page.screenshot({ path: `${reportDir}/preview.png` });
  await page.getByRole('button', { name: /确认执行 \d+ 项/ }).click();
  const records = page.getByRole('dialog', { name: '任务记录', exact: true });
  await records.getByText('已完成（有跳过）', { exact: true }).waitFor();
  if (await records.getByRole('button', { name: '继续 / 对账', exact: true }).count())
    throw Error('Skipped-only task offers retry');
  const data = await page.evaluate(async () => {
    const boot = await window.workbench.bootstrap();
    const task = await window.workbench.task(boot.tasks[0].id);
    return {
      task,
      summary: boot.tasks[0],
      nested: await window.workbench.inspect('demo-work', 'plan'),
    };
  });
  const { SqliteStore } = await import('../dist-desktop/core/store.js');
  const storePath = path.join(profile, 'skip-counts.sqlite');
  const sql = new SqliteStore(
    storePath,
    (s) => s,
    (s) => s,
  );
  sql.saveTask(data.task, data.task.items);
  sql.close();
  const restored = new SqliteStore(
    storePath,
    (s) => s,
    (s) => s,
  );
  const summary = restored.taskSummaries()[0];
  if (
    summary.skipped !== 1 ||
    summary.succeeded !== data.task.items.length - 1 ||
    restored.tasks()[0].items.find((i) => i.file.id === 'plan')?.state !== 'skipped'
  )
    throw Error('SQLite counts/restart failed');
  restored.close();
  if (!data.task.request.skipUntransferable || data.summary.skipped !== 1)
    throw Error('Option/count not persisted');
  if (data.task.items.find((i) => i.file.id === 'plan')?.state !== 'skipped')
    throw Error('Missing skipped item');
  if (data.task.items.some((i) => i.file.id !== 'plan' && i.state !== 'succeeded'))
    throw Error('Owned files did not complete');
  if (data.nested.parents[0] !== 'design-a' || data.nested.ownedByMe)
    throw Error('Skipped ownership or tree changed');
  await records.getByRole('button', { name: '查看明细', exact: true }).click();
  await page.getByRole('dialog').last().getByText('已跳过', { exact: true }).waitFor();
  await page.screenshot({ path: `${reportDir}/results.png` });
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: '导出明细', exact: true })
    .click();
  const csv = await readFile(path.join(profile, 'skip-report.csv'), 'utf8');
  if (!csv.includes('skipped') || !csv.includes('保留原所有者'))
    throw Error('Report omits skip state/reason');
  await page.getByRole('dialog').last().getByRole('button', { name: '完成', exact: true }).click();
  await records.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: '选择 品牌与设计', exact: true }).check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  await move.check();
  const recursive = page.getByRole('checkbox', {
    name: '包含文件夹内后代（仍按当前所有者范围筛选）',
    exact: true,
  });
  if (!(await recursive.isChecked())) await recursive.check();
  if (await skip.count()) throw Error('Mode switch returned on next operation');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    `${reportDir}/results.json`,
    JSON.stringify(
      {
        passed: true,
        checks: [
          'single best-effort policy; no mode switch',
          'responsive form',
          'foreign-owner count and email warning before execution',
          'IPC and SQLite persistence',
          'hierarchy retained',
          'skip count distinct from success',
          'CSV states and reasons',
          'console clean',
        ],
        data,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Skip transfer UI passed');
} finally {
  await app.close();
}
