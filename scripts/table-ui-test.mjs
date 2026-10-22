import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-table-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('本地测试/云盘工作台.exe'), env });
let expectedAfterRestart;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    globalThis.tableReads = 0;
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      globalThis.tableReads++;
      const result = await original(...args);
      const item = result.files.find((f) => f.id === 'brand');
      if (item)
        item.permissions = Array.from({ length: 80 }, (_, i) => ({
          id: 'qa-' + i,
          type: 'user',
          role: 'reader',
          emailAddress: (i === 0 ? 'a'.repeat(64) : 'collaborator-' + i) + '@example.com',
        }));
      return result;
    });
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  const row = page.locator('tr[data-file-id="brand"]'),
    permissions = row.locator('.row-permissions');
  await permissions.waitFor();
  const limits = await permissions.evaluate((el) => ({
    height: el.clientHeight,
    total: el.scrollHeight,
    records: el.children.length,
  }));
  if (limits.height > 40 || limits.total <= limits.height || limits.records !== 80)
    throw Error('权限高度限制或完整列表错误：' + JSON.stringify(limits));
  if ((await row.boundingBox()).height > 52) throw Error('80个邮箱把行撑得过高');
  await permissions.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = await permissions.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    last: el.lastElementChild.getBoundingClientRect().bottom,
  }));
  if (Math.abs(last.bottom - last.last) > 3) throw Error('滚动后最后一个邮箱不可达');
  await permissions.click();
  if (
    (await row
      .getByRole('button', { name: '品牌与设计', exact: true })
      .getAttribute('aria-expanded')) !== 'false'
  )
    throw Error('读取权限时错误折叠/展开目录');
  const name = page.locator('th[data-column="name"]'),
    size = page.locator('th[data-column="size"]');
  const before = (await name.boundingBox()).width,
    sizeBefore = (await size.boundingBox()).width;
  const handle = page.getByRole('separator', { name: '调整名称列宽', exact: true });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  if (Math.abs((await name.boundingBox()).width - before - 180) > 2)
    throw Error('拖拽宽度与位移不一致：'+JSON.stringify({before, after:(await name.boundingBox()).width, prefs:await page.evaluate(()=>localStorage.getItem('workbench.columnWidths'))}));
  if (Math.abs((await size.boundingBox()).width - sizeBefore) > 2)
    throw Error('调整名称列不应改变大小列');
  const permHandle = page.getByRole('separator', { name: '调整邮箱与权限列宽', exact: true });
  await permHandle.focus();
  for (let i = 0; i < 25; i++) await permHandle.press('ArrowLeft');
  if (Math.abs((await page.locator('th[data-column="permissions"]').boundingBox()).width - 160) > 2)
    throw Error('权限列最小宽度不正确');
  if ((await permissions.evaluate((el) => el.clientHeight)) > 40) throw Error('窄列时权限行高失控');
  await page.locator('.table-scroll').evaluate((el) => {
    el.scrollLeft = 0;
  });
  await handle.dblclick();
  if (Math.abs((await name.boundingBox()).width - 280) > 2) throw Error('双击未恢复默认名称列宽');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('workbench.columnWidths')),
  );
  if (!saved || saved.name !== 280 || saved.permissions !== 160) throw Error('列宽没有保存');
  if ((await app.evaluate(() => globalThis.tableReads)) !== 1)
    throw Error('调整列宽/滚动权限不应调用Drive');
  expectedAfterRestart = {
    name: (await name.boundingBox()).width,
    permissions: (await page.locator('th[data-column="permissions"]').boundingBox()).width,
  };
  await page.reload();
  await page.locator('th[data-column="name"]').waitFor();
  if (
    Math.abs(
      (await page.locator('th[data-column="name"]').boundingBox()).width -
        expectedAfterRestart.name,
    ) > 2
  )
    throw Error('重新打开未恢复列宽');
  if (
    Math.abs(
      (await page.locator('th[data-column="permissions"]').boundingBox()).width -
        expectedAfterRestart.permissions,
    ) > 2
  )
    throw Error('重新打开未恢复权限列宽');
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.locator('tr[data-file-id="brand"]').waitFor();
  await page.locator('.table-scroll').evaluate((el) => {
    el.scrollLeft = 0;
  });
  if (await page.locator('.toast .icon-button').count())
    await page.locator('.toast .icon-button').click();
  await page.screenshot({ path: 'test-results/12-resizable-columns.png' });
  if (errors.length) throw Error(errors.join('\n'));
  const checks = [
    '80 permission records bounded to 40px',
    'last email reachable by cell scrolling',
    'permission interaction does not expand folder',
    'drag changes only target column',
    'minimum column widths',
    'double-click reset',
    'saved widths restored after reload',
    'resize and scrolling do not call Drive',
  ];
  await writeFile(
    'test-results/table-results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Table UI passed:', checks.join('; '));
} finally {
  await app.close();
}

const restarted = await electron.launch({
  executablePath: path.resolve('本地测试/云盘工作台.exe'),
  env,
});
try {
  const page = await restarted.firstWindow();
  await page.locator('th[data-column="name"]').waitFor();
  const nameWidth = (await page.locator('th[data-column="name"]').boundingBox()).width;
  const permissionWidth = (await page.locator('th[data-column="permissions"]').boundingBox()).width;
  if (
    Math.abs(nameWidth - expectedAfterRestart.name) > 2 ||
    Math.abs(permissionWidth - expectedAfterRestart.permissions) > 2
  )
    throw Error('进程重启后未恢复列宽');
  console.log('Column widths restored after actual process restart.');
} finally {
  await restarted.close();
}
