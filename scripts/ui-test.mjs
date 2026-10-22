import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = {
  ...process.env,
  WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-workbench-v11-')),
};
delete env.ELECTRON_RUN_AS_NODE;
await mkdir('test-results', { recursive: true });
let app;
const checks = [];
try {
  app = await electron.launch({
    ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : { args: ['.'] }),
    env,
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  // Instrument only the isolated demo adapter; production accounts are never opened.
  await app.evaluate(({ ipcMain }) => {
    globalThis.qaReads = { list: 0, get: 0, permissions: 0 };
    for (const [method, key] of [
      ['list', 'list'],
      ['inspect', 'get'],
      ['permissions', 'permissions'],
    ]) {
      const channel = 'workbench:' + method,
        original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw Error('Missing QA IPC handler');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => {
        globalThis.qaReads[key]++;
        return original(...args);
      });
    }
  });
  const reads = () => app.evaluate(() => ({ ...globalThis.qaReads }));
  if (await page.locator('tr[data-file-id]').count()) throw Error('打开账号时不应自动读取目录');
  const scan = async () => {
    await page.getByRole('button', { name: '扫描', exact: true }).click();
    await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
    await page.locator('.scan-summary').filter({ hasText: '扫描时间' }).waitFor();
  };
  await scan();
  await page
    .getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true })
    .waitFor();
  const scanned = await reads();
  if (scanned.list !== 1) throw Error('全部扫描应只调用一次全局列表');
  await page.getByRole('button', { name: '展开 项目资料', exact: true }).click();
  await page.getByRole('button', { name: '展开 网站改版', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 页面线框图.pdf', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('网站改版执行');
  await page.getByRole('checkbox', { name: '选择 网站改版执行计划', exact: true }).check();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '工作账号 lin.work@example.com', exact: false }).click();
  await page.getByText('点击扫描，生成本次目录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '林予安 yu.an.lin@example.com', exact: false }).click();
  await page
    .getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true })
    .waitFor();
  if (JSON.stringify(await reads()) !== JSON.stringify(scanned))
    throw Error('浏览、展开、搜索、选择或切换账号触发了Drive读取');
  console.log('Step complete');
  checks.push(
    'explicit full scan; zero Drive reads during browsing/search/selection/account switch',
  );
  const folder = page.locator('tr[data-file-id="projects"]');
  if (!(await folder.innerText()).includes('1.7 MB + 2 项未知'))
    throw Error('文件夹后代大小汇总错误');
  checks.push('folder aggregate sizes and unknown values');
  await page.screenshot({ path: 'test-results/01-workspace.png' });
  const choose = async (name) => {
    const clear = page.getByRole('button', { name: '清空选择', exact: true });
    if (await clear.count()) await clear.click();
    const checkbox = page.getByRole('checkbox', { name: '选择 ' + name, exact: true });
    if (!(await checkbox.count()))
      await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill(name);
    await checkbox.check();
  };
  const records = () => page.getByRole('dialog', { name: '任务记录', exact: true });
  const execute = async () => {
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '生成变更预览', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /确认执行 1 项/ })
      .click();
    await records().locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  };
  const closeRecords = () =>
    records().getByRole('button', { name: '关闭对话框', exact: true }).click();
  await choose('2026 品牌升级 · 项目简报');
  const beforePermission = await reads();
  await page.getByRole('button', { name: /读取访问权限|刷新访问权限/ }).click();
  await page.locator('.console-permission').first().waitFor();
  if ((await reads()).permissions !== beforePermission.permissions + 1)
    throw Error('显式读取权限未执行');
  await page.getByRole('button', { name: '添加多个邮箱', exact: true }).click();

  await page.getByRole('textbox', { name: '协作者列表', exact: true }).fill('reviewer@example.com');
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByText('添加 reviewer@example.com · writer', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/02-share-plan.png' });
  await page.getByRole('button', { name: '确认执行 1 项', exact: true }).click();
  await records().locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  await closeRecords();
  checks.push('on-demand permission read; collaborator add preview/execution');
  await page.getByRole('button', { name: '修改邮箱角色', exact: true }).click();
  await page
    .getByRole('textbox', { name: '协作者列表', exact: true })
    .fill('reviewer@example.com,missing@example.com');
  await page
    .getByRole('dialog')
    .locator('label.field')
    .filter({ hasText: '权限角色' })
    .locator('select')
    .selectOption('reader');
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByText('reviewer@example.com → reader', { exact: true }).waitFor();
  if (await page.getByText('添加 missing@example.com · reader', { exact: true }).count())
    throw Error('修改角色不应新增邮箱');
  await page.getByRole('button', { name: '确认执行 1 项', exact: true }).click();
  await records().locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  await closeRecords();
  await page.getByRole('button', { name: '移除指定邮箱', exact: true }).click();
  await page.getByRole('textbox', { name: '协作者列表', exact: true }).fill('reviewer@example.com');
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page.getByText('移除 reviewer@example.com', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认执行 1 项', exact: true }).click();
  await records().locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  await closeRecords();
  checks.push('explicit permission actions: add, update existing only, remove specified email');
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  await execute();
  await records().getByRole('button', { name: '查看明细', exact: true }).first().click();
  await page.getByText(/目标 lin.work@example.com 已确认拥有/).waitFor();
  await page.screenshot({ path: 'test-results/03-transfer-result.png' });
  await page.getByRole('dialog').last().getByRole('button', { name: '完成', exact: true }).click();
  await closeRecords();
  checks.push('ownership transfer + target acceptance');
  await page.getByText('更多文件操作', { exact: true }).click();
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('界面验收文件夹');
  await execute();
  await closeRecords();
  await choose('界面验收文件夹');
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('已重命名的文件夹');
  await execute();
  await closeRecords();
  await page.getByRole('checkbox', { name: '选择 已重命名的文件夹', exact: true }).waitFor();
  checks.push('create and rename update session without scan');
  await choose('产品设计规范 v2.0.pdf');
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await page.getByRole('textbox', { name: '目标文件夹', exact: true }).fill('archive');
  await execute();
  await closeRecords();
  await page.getByRole('button', { name: '展开 归档文件', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 产品设计规范 v2.0.pdf', exact: true }).waitFor();
  await choose('产品设计规范 v2.0.pdf');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await execute();
  await closeRecords();
  await page
    .getByRole('checkbox', { name: '选择 产品设计规范 v2.0.pdf', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByRole('combobox', { name: '扫描范围', exact: true }).selectOption('trash');
  await scan();
  await choose('产品设计规范 v2.0.pdf');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await execute();
  await closeRecords();
  await page
    .getByRole('checkbox', { name: '选择 产品设计规范 v2.0.pdf', exact: true })
    .waitFor({ state: 'hidden' });
  checks.push('move, delete to trash, explicit trash scan, restore');
  await page.getByRole('combobox', { name: '扫描范围', exact: true }).selectOption('folder');
  await page.getByRole('textbox', { name: '扫描路径', exact: true }).fill('root');
  await scan();
  await choose('品牌视觉素材.zip');
  await page.getByRole('button', { name: '复制链接', exact: true }).click();
  await page.getByText('已复制 1 个链接', { exact: true }).waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (!copied.includes('/images/')) throw Error('链接未复制');
  const htmlPath = path.resolve('test-results/session-directory.html');
  await app.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ filePath: output, canceled: false });
  }, htmlPath);
  const beforeExport = await reads();
  await page.getByRole('button', { name: '导出本次目录', exact: true }).click();
  await page.getByText('交互快照已导出', { exact: true }).waitFor();
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes('MB') || !html.includes('已重命名的文件夹')) throw Error('快照导出不完整');
  if (JSON.stringify(await reads()) !== JSON.stringify(beforeExport))
    throw Error('导出不应重新读取API');
  checks.push('specified folder scan; clipboard; snapshot export reuses scan');
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  await page.getByRole('button', { name: '展开 项目资料', exact: true }).click();
  await page.screenshot({ path: 'test-results/04-tree-view.png' });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.screenshot({ path: 'test-results/05-compact.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw Error('紧凑窗口水平溢出');
  checks.push('compact layout at 1100x760');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/ui-results.json',
    JSON.stringify(
      { passed: true, checks, errors, executable: process.argv[2] || 'source build' },
      null,
      2,
    ),
  );
  console.log('UI passed:', checks.join('; '));
} finally {
  if (app) await app.close();
}
