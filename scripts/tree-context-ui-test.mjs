import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-selection-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('本地测试/云盘工作台.exe'), env });
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    globalThis.contextReads = 0;
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      globalThis.contextReads++;
      const result = await original(...args);
      result.files.push({
        id: 'context-orphan',
        name: '只有查看权限.pdf',
        mimeType: 'application/pdf',
        parents: ['invisible'],
        ownedByMe: false,
        owners: [{ emailAddress: 'other@example.com' }],
        capabilities: { canShare: false, canTrash: false },
      });
      return result;
    });
  });
  const owner = page.getByRole('combobox', { name: '所有者筛选', exact: true });
  if ((await owner.inputValue()) !== 'all') throw Error('默认应为全部');
  const empty = await page.locator('.table-scroll').boundingBox();
  await page.mouse.move(empty.x + 100, empty.y + 130);
  await page.mouse.down();
  await page.mouse.move(empty.x + 200, empty.y - 90, { steps: 8 });
  if (await page.locator('.marquee').count()) throw Error('空列表显示文件框选');
  if (await page.evaluate(() => window.getSelection().toString()))
    throw Error('空列表拖动选中了界面文字');
  await page.mouse.up();
  checks.push('default all; no text selection or marquee in empty list');
  await page.setViewportSize({ width: 1800, height: 950 });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.locator('.scan-summary').waitFor();
  await page.getByRole('button', { name: '展开 归档文件', exact: true }).click();
  const old = page.locator('tr[data-file-id="old"]');
  await old.getByRole('checkbox').check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByRole('button', { name: '确认执行 1 项', exact: true }).click();
  const records = page.getByRole('dialog', { name: '任务记录', exact: true });
  await records.locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  await records.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await old.locator('.owner-cell').filter({ hasText: 'lin.work@example.com' }).waitFor();
  if (await old.getByRole('checkbox').isDisabled()) throw Error('他人文件无法选择复制');
  if (await page.getByRole('button', { name: '清空选择', exact: true }).count())
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await old.getByRole('button', { name: '复制 旧版项目说明.pdf 的链接', exact: true }).click();
  if (!(await app.evaluate(({ clipboard }) => clipboard.readText())).includes('/old/'))
    throw Error('未选中行复制失败');
  if (await page.locator('tr.is-selected').count()) throw Error('单行复制改变了选择');
  await owner.selectOption('mine');
  await old.waitFor({ state: 'hidden' });
  if ((await page.locator('tr[data-file-id="archive"] .folder-count').innerText()) !== '0')
    throw Error('本人范围计数包含他人文件');
  if (await page.locator('.orphan-group').count()) throw Error('本人范围显示了只有他人文件的分组');
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('旧版项目说明');
  await page.getByText('没有匹配的文件', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await owner.selectOption('all');
  await old.waitFor();
  if ((await page.locator('tr[data-file-id="archive"] .folder-count').innerText()) !== '1')
    throw Error('全部范围计数不正确');
  await page.getByRole('button', { name: /展开 共享目录或未分类的文件/ }).click();
  const readOnly = page.locator('tr[data-file-id="context-orphan"]');
  await readOnly.waitFor();
  await readOnly.getByRole('button', { name: '复制 只有查看权限.pdf 的链接', exact: true }).click();
  if (!(await app.evaluate(({ clipboard }) => clipboard.readText())).includes('context-orphan'))
    throw Error('查看权限文件无法复制');
  await readOnly.getByRole('checkbox').check();
  await page.getByRole('button', { name: '复制链接', exact: true }).click();
  if (!(await app.evaluate(({ clipboard }) => clipboard.readText())).includes('context-orphan'))
    throw Error('查看权限文件批量复制失败');
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  // Extra workspace headings can put this row below the viewport. Start the
  // gesture from a visible data cell, as a user would, rather than stale geometry.
  await old.locator('td').nth(2).scrollIntoViewIfNeeded();
  // scrollIntoView can align the row underneath the sticky table header.
  await page.locator('.table-scroll').evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 80);
  });
  await page.waitForFunction(() => {
    const td = document.querySelector('tr[data-file-id="old"] td:nth-child(3)');
    if (!td) return false;
    const b = td.getBoundingClientRect();
    return document.elementFromPoint(b.x + 10, b.y + b.height / 2)?.closest('td') === td;
  });
  const cell = await old.locator('td').nth(2).boundingBox();
  const header = await page.locator('.file-table thead').boundingBox();
  await page.mouse.move(cell.x + 10, cell.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + 60, header.y - 50, { steps: 8 });
  await page.locator('.marquee').waitFor();
  if (await page.evaluate(() => window.getSelection().toString()))
    throw Error('文件框选同时选中了文字');
  if ((await page.locator('.marquee').boundingBox()).y < header.y + header.height - 2)
    throw Error('框选区域覆盖表头工具栏');
  await page.mouse.up();
  await page.locator('.marquee').waitFor({ state: 'hidden' });
  if (await page.evaluate(() => document.body.classList.contains('selecting-files')))
    throw Error('框选状态未清理');
  if (await page.getByRole('button', { name: '清空选择', exact: true }).count())
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
  const fit = () =>
    page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector('.file-table').getBoundingClientRect().width -
            document.querySelector('.table-scroll').clientWidth,
        ) <= 2,
    );
  await page.getByRole('button', { name: '自适应列宽', exact: true }).click();
  await fit();
  await page.setViewportSize({ width: 2200, height: 950 });
  await fit();
  await page.screenshot({ path: 'test-results/17-strict-owner-copy.png' });
  if ((await app.evaluate(() => globalThis.contextReads)) !== 1)
    throw Error('浏览筛选复制缩放重新扫描');
  checks.push(
    'ownership transfer remains visible in all; mine strictly hides foreign files; filtered folder counts; foreign empty group hidden; direct row copy without selection; viewer-only file single and batch copy; marquee suppresses native selection and stays below header; adaptive columns; no extra Drive scans',
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/context-results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Selection/owner/copy UI passed:', checks.join('; '));
} finally {
  await app.close();
}
