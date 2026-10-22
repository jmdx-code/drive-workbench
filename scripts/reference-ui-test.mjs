import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotHtml } from '../dist-desktop/core/snapshot.js';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-reference-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('本地测试/云盘工作台.exe'), env });
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    globalThis.referenceReads = 0;
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      globalThis.referenceReads++;
      const result = await original(...args);
      if (args[2] === 'all')
        result.files.push({
          id: 'fixture-orphan',
          ownedByMe: true,
          name: '父目录不可见的文件.pdf',
          mimeType: 'application/pdf',
          parents: ['invisible'],
          size: '2048',
          quotaBytesUsed: '4096',
          createdTime: '2026-02-03T00:00:00Z',
          permissions: [
            { id: 'fixture-p', type: 'user', role: 'reader', emailAddress: 'viewer@example.com' },
          ],
        });
      return result;
    });
  });
  await page.evaluate(() => {
    window.scanEvents = [];
    window.workbench.onScanProgress((p) => window.scanEvents.push(p));
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  const orphan = page.getByRole('button', { name: /展开 共享目录或未分类的文件/ });
  await orphan.waitFor();
  if (
    !(await page.evaluate(() =>
      window.scanEvents.some((p) => p.pages === 1 && p.items > 0 && p.requestId),
    ))
  )
    throw Error('未收到分页扫描进度');
  const summary = page.getByRole('region', { name: '目录统计' });
  await page.locator('.scan-summary').filter({ hasText: '统计对象：' }).waitFor();
  const summaryBefore = await page.locator('.scan-summary').innerText();
  const projectRow = page.locator('tr[data-file-id="projects"]');
  await projectRow.locator('.date-cell').click();
  await page.getByRole('checkbox', { name: '选择 网站改版', exact: true }).waitFor();
  if (await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).isChecked())
    throw Error('单击文件夹行不应选中');
  await projectRow.getByRole('button', { name: '项目资料', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '选择 网站改版', exact: true })
    .waitFor({ state: 'hidden' });
  if ((await page.locator('.scan-summary').innerText()) !== summaryBefore)
    throw Error('展开收起不应改变总统计');
  const font = await projectRow
    .locator('.name-content')
    .evaluate((el) => getComputedStyle(el).fontSize);
  if (parseFloat(font) < 16) throw Error('目录字号不足16px');
  if (
    !(await projectRow.getByRole('img', { name: '文件夹图标', exact: true }).locator('svg').count())
  )
    throw Error('文件夹彩色图标未显示');
  await page.getByRole('checkbox', { name: '全选当前可见文件', exact: true }).check();
  if (!(await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).isChecked()))
    throw Error('折叠文件夹自身必须可选');
  await page.getByRole('button', { name: '展开 项目资料', exact: true }).click();
  if (await page.getByRole('checkbox', { name: '选择 网站改版', exact: true }).isChecked())
    throw Error('折叠的后代被错误全选');
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await orphan.click();
  await page.getByRole('checkbox', { name: '选择 父目录不可见的文件.pdf', exact: true }).check();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('viewer@example.com');
  await page.locator('tr[data-file-id="fixture-orphan"]').waitFor();
  if (
    !(await page.locator('tr[data-file-id="fixture-orphan"]').innerText()).includes(
      'viewer@example.com · 查看者',
    )
  )
    throw Error('未显示邮箱与角色');
  if ((await app.evaluate(() => globalThis.referenceReads)) !== 1)
    throw Error('查看权限或筛选触发了重新扫描');
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await page.screenshot({ path: 'test-results/08-reference-details.png' });
  checks.push(
    'local exe launch; top totals; 16px readable text; colorful icons; click folder row/name expands without selection; orphan grouping; checkbox-only click selection; inline email roles; local email search without API',
  );
  const data = [
    {
      id: 'folder',
      name: '资料',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    },
    {
      id: 'nested',
      name: '内部文件',
      mimeType: 'application/pdf',
      parents: ['folder'],
      size: '100',
      quotaBytesUsed: '200',
      permissions: [{ id: 'p', type: 'user', role: 'reader', emailAddress: 'reader@example.com' }],
    },
    {
      id: 'rootfile',
      name: '根文件',
      mimeType: 'application/pdf',
      parents: ['root'],
      size: '10',
      quotaBytesUsed: '10',
    },
    { id: 'unfiled', name: '未归档', mimeType: 'application/pdf', parents: ['missing'] },
  ];
  const output = path.resolve('test-results/reference-snapshot.html');
  await writeFile(output, snapshotHtml(data, '参考交互验收', 'root'), 'utf8');
  const csvPath = path.resolve('test-results/reference-directory.csv');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ filePath: target, canceled: false });
  }, csvPath);
  await page.evaluate(
    (data) => window.workbench.exportSnapshot('demo-lin', data, true, 'root'),
    data,
  );
  if (!(await readFile(csvPath, 'utf8')).includes('reader@example.com'))
    throw Error('CSV 明细导出未通过IPC写入');
  const next = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, output) => {
    const w = new BrowserWindow({
      width: 1280,
      height: 850,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await w.loadFile(output);
  }, output);
  const html = await next;
  html.setDefaultTimeout(10000);
  html.on('pageerror', (e) => errors.push(e.message));
  await html.locator('#select').click();
  if ((await html.locator('input:checked').count()) !== 2)
    throw Error('HTML 全选应只选折叠目录自身和根文件');
  await html.locator('details').first().locator('summary').click();
  if (await html.getByRole('checkbox', { name: '选择 内部文件', exact: true }).isChecked())
    throw Error('HTML 隐藏后代被错误选择');
  await html.getByRole('checkbox', { name: '选择 内部文件', exact: true }).check();
  await html.locator('#collapse').click();
  if (!(await html.locator('#count').innerText()).includes('隐藏'))
    throw Error('HTML 未提示隐藏选择');
  await html.locator('#select').click();
  if (await html.locator('input:checked').count()) throw Error('HTML 智能清空应包含隐藏项');
  await html.locator('input[type=search]').fill('reader@example.com');
  await html
    .getByRole('checkbox', { name: '选择 内部文件', exact: true })
    .waitFor({ state: 'visible' });
  await html.locator('input[type=search]').fill('');
  if (await html.locator('details[open]').count()) throw Error('搜索清除没有恢复折叠状态');
  await html.locator('#expand').click();
  await html.locator('#select').click();
  await html.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.copied = text;
        },
      },
      configurable: true,
    });
  });
  await html.locator('#copy').click();
  await html.locator('#copy-status').filter({ hasText: '已复制' }).waitFor();
  const copied = await html.evaluate(() => window.copied);
  if (copied.split('\n').length !== 4) throw Error('HTML 批量链接未按行复制');
  await html.screenshot({ path: 'test-results/09-reference-html.png' });
  checks.push(
    'HTML expand/collapse; visible-only select; hidden selection count; smart clear; email search; fold state restore; newline-separated link copy',
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/reference-results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Reference UI passed:', checks.join('; '));
} finally {
  await app.close();
}
