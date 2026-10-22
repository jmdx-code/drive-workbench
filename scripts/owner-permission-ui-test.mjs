import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-owner-ui-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('本地测试/云盘工作台.exe'), env });
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    globalThis.ownerReads = 0;
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      globalThis.ownerReads++;
      const result = await original(...args);
      const make = (id, ownedByMe, email, parents = ['root']) => ({
        id,
        name: '权限筛选测试-' + id,
        mimeType: 'application/pdf',
        parents,
        ownedByMe,
        owners: email ? [{ emailAddress: email }] : undefined,
        permissions: [
          {
            id: 'r-' + id,
            type: 'user',
            role: 'reader',
            emailAddress: 'search-shared@example.com',
          },
        ],
      });
      result.files.push(
        make('qa-mine', true, 'yu.an.lin@example.com'),
        make('qa-other', false, 'other@example.com'),
        make('qa-unknown', undefined),
        make('qa-nested', true, 'yu.an.lin@example.com', ['qa-parent']),
        {
          id: 'qa-parent',
          name: '他人的文件夹',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root'],
          ownedByMe: false,
          owners: [{ emailAddress: 'other@example.com' }],
        },
      );
      return result;
    });
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.locator('.scan-summary').waitFor();
  const waitRows = (n) =>
    page.waitForFunction(
      (expected) => document.querySelectorAll('tr[data-file-id]').length === expected,
      n,
    );
  const owner = page.getByRole('combobox', { name: '所有者筛选', exact: true }),
    search = page.getByRole('textbox', { name: '搜索文件', exact: true });
  if ((await owner.inputValue()) !== 'all') throw Error('默认不是全部');
  await owner.selectOption('mine');
  await page.locator('th[data-column="owner"]').waitFor();
  await search.fill('权限筛选测试');
  await page.locator('tr[data-file-id="qa-nested"]').waitFor();
  await waitRows(2);
  if ((await page.locator('tr[data-file-id]').count()) !== 2)
    throw Error(
      '搜索未叠加本人筛选或遗漏共享目录内本人文件：' +
        JSON.stringify(
          await page
            .locator('tr[data-file-id]')
            .evaluateAll((els) => els.map((el) => el.dataset.fileId)),
        ),
    );
  if ((await page.locator('tr[data-file-id="qa-mine"] .owner-cell').innerText()) !== '我')
    throw Error('所有者列不正确');
  await owner.selectOption('all');
  await page.locator('tr[data-file-id="qa-other"]').waitFor();
  await waitRows(4);
  if ((await page.locator('tr[data-file-id]').count()) !== 4) throw Error('全部范围遗漏文件');
  await page.getByRole('checkbox', { name: '选择 权限筛选测试-qa-other', exact: true }).check();
  await owner.selectOption('mine');
  if (await page.getByRole('checkbox', { checked: true }).count())
    throw Error('切换所有者后遗留选择');
  await search.fill('search-shared@example.com');
  await waitRows(2);
  if ((await page.locator('tr[data-file-id]').count()) !== 2) throw Error('邮箱搜索突破本人范围');
  await owner.selectOption('others');
  await page.locator('tr[data-file-id="qa-other"]').waitFor();
  await waitRows(1);
  if ((await page.locator('tr[data-file-id]').count()) !== 1) throw Error('他人筛选不准确');
  if (
    (await page.locator('tr[data-file-id="qa-other"] .owner-cell').innerText()) !==
    'other@example.com'
  )
    throw Error('他人邮箱未显示');
  await owner.selectOption('unknown');
  await page.locator('tr[data-file-id="qa-unknown"]').waitFor();
  await waitRows(1);
  if ((await page.locator('tr[data-file-id]').count()) !== 1)
    throw Error('未知所有者混入已知所有者');
  await owner.selectOption('mine');
  await search.fill('品牌');
  await page.screenshot({ path: 'test-results/13-owner-filter.png' });
  if ((await app.evaluate(() => globalThis.ownerReads)) !== 1)
    throw Error('所有者过滤额外读取Drive');
  checks.push(
    'default all; explicit mine; search and owner intersection; mine inside foreign folder; owner email column; unknown distinct; scope change clears selection; no additional Drive reads',
  );
  await search.fill('2026 品牌升级');
  await page.getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true }).check();
  const presets = [
    ['添加多个邮箱', 1, true],
    ['修改邮箱角色', 1, true],
    ['移除指定邮箱', 0, true],
    ['替换协作者名单', 1, true],
    ['开启链接访问', 1, false],
    ['关闭链接访问', 0, false],
    ['移除群组共享', 0, false],
    ['移除域共享', 0, false],
    ['编辑者分享限制', 1, false],
    ['复制与下载限制', 1, false],
  ];
  for (const [name, selects, emails] of presets) {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    if ((await dialog.getByRole('combobox').count()) !== selects)
      throw Error(name + '展示无关选项');
    if (
      (await dialog.getByRole('textbox', { name: '协作者列表', exact: true }).count()) !==
      Number(emails)
    )
      throw Error(name + '邮箱输入不符合任务');
    if (await dialog.getByText('其他分享设置', { exact: false }).count())
      throw Error('简单操作泄露高级表单');
    if (name === '修改邮箱角色') {
      await dialog
        .getByRole('textbox', { name: '协作者列表', exact: true })
        .fill('one@example.com\ntwo@example.com');
      await page.screenshot({ path: 'test-results/14-simple-permission.png' });
    }
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.getByRole('button', { name: '高级组合设置', exact: true }).click();
  await page.getByText('其他分享设置', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  checks.push(
    'ten dedicated forms; only relevant inputs; no recursive option for files; advanced combinations retained separately',
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/owner-permission-results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Owner/permission UI passed:', checks.join('; '));
} finally {
  await app.close();
}
