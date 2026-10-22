import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-depth-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('本地测试/云盘工作台.exe'), env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    globalThis.depthRequests = [];
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      globalThis.depthRequests.push(args[6] ?? null);
      return original(...args);
    });
  });
  const enabled = page.getByRole('checkbox', { name: '最大扫描层级', exact: true }),
    number = page.getByRole('spinbutton', { name: '扫描层级数', exact: true }),
    scan = () => page.getByRole('button', { name: '扫描', exact: true }).click();
  if (
    (await enabled.isChecked()) ||
    !(await number.isDisabled()) ||
    (await number.inputValue()) !== '1'
  )
    throw Error('默认层级开关不正确');
  await enabled.check();
  await scan();
  await page.locator('.depth-summary').filter({ hasText: '最多 1 层' }).waitFor();
  const brand = page.locator('tr[data-file-id="brand"]');
  if ((await brand.locator('.folder-count').innerText()) !== '未扫描')
    throw Error('边界目录被显示为空');
  if (!(await brand.innerText()).includes('下级未扫描')) throw Error('边界目录大小误报');
  await brand.getByRole('button', { name: '品牌与设计', exact: true }).click();
  await page
    .getByText('此目录下级未扫描；请将顶部扫描范围设为指定目录，填入该目录后扫描', { exact: true })
    .waitFor();
  if (await page.locator('tr[data-file-id="logo"]').count()) throw Error('1层返回了第2层');
  await number.fill('2');
  await scan();
  await page.locator('.depth-summary').filter({ hasText: '最多 2 层' }).waitFor();
  await brand.getByRole('button', { name: '品牌与设计', exact: true }).click();
  await page.locator('tr[data-file-id="logo"]').waitFor();
  await page.getByRole('button', { name: '展开 项目资料', exact: true }).click();
  await page.locator('tr[data-file-id="design-a"]').waitFor();
  if ((await page.locator('tr[data-file-id="design-a"] .folder-count').innerText()) !== '未扫描')
    throw Error('第2层边界未标识');
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('页面线框图');
  await page.getByText('没有匹配的文件', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await page.getByRole('combobox', { name: '扫描范围', exact: true }).selectOption('folder');
  await page.getByRole('textbox', { name: '扫描路径', exact: true }).fill('projects');
  await number.fill('1');
  await scan();
  await page.locator('.depth-summary').filter({ hasText: '最多 1 层' }).waitFor();
  await page.locator('tr[data-file-id="design-a"]').waitFor();
  if (await page.locator('tr[data-file-id="projects"]').count())
    throw Error('指定目录层级起点不正确');
  await page.screenshot({ path: 'test-results/16-scan-depth.png' });
  await number.fill('0');
  await scan();
  await page.getByText('最大扫描层级须为1到1000的整数', { exact: true }).waitFor();
  if ((await app.evaluate(() => globalThis.depthRequests.length)) !== 3)
    throw Error('无效层级发起了请求');
  await enabled.uncheck();
  if (!(await number.isDisabled())) throw Error('取消未禁用数字框');
  await scan();
  await page.locator('.depth-summary').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('页面线框图');
  await page.locator('tr[data-file-id="wireframes"]').waitFor();
  const requests = await app.evaluate(() => globalThis.depthRequests);
  if (JSON.stringify(requests) !== JSON.stringify([1, 2, 1, null]))
    throw Error('层级参数未正确传递');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/depth-results.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          'default disabled with value 1',
          'current layer only',
          '2 layers stop at grandchildren',
          'boundary folders not empty',
          'folder-relative depth',
          'invalid depth rejected',
          'unchecked scans all descendants',
        ],
        requests,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Depth UI passed', requests);
} finally {
  await app.close();
}
