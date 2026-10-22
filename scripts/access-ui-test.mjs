import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-access-')) };
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
    globalThis.accessReads = 0;
    globalThis.revokeShare = false;
    globalThis.revokeOwner = false;
    const caps = {
      canEdit: true,
      canShare: true,
      canRename: true,
      canCopy: true,
      canMoveItemWithinDrive: true,
      canTrash: true,
      canUntrash: true,
      canChangeCopyRequiresWriterPermission: true,
    };
    const make = (id, name, ownedByMe, capabilities) => ({
      id,
      name,
      mimeType: 'application/pdf',
      parents: ['root'],
      ownedByMe,
      owners: [{ emailAddress: ownedByMe ? 'yu.an.lin@example.com' : 'other@example.com' }],
      capabilities,
    });
    const fixtures = [
      make('access-owner', '校验-所有者', true, { ...caps }),
      make('access-editor', '校验-编辑者', false, {
        ...caps,
        canTrash: false,
        canMoveItemWithinDrive: false,
        canChangeCopyRequiresWriterPermission: false,
      }),
      make(
        'access-viewer',
        '校验-查看者',
        false,
        Object.fromEntries(Object.keys(caps).map((k) => [k, false])),
      ),
      make('access-unknown', '校验-未知权限', true, {}),
    ];
    const list = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      const result = await list(...args);
      result.files.push(...structuredClone(fixtures));
      return result;
    });
    const inspect = ipcMain._invokeHandlers.get('workbench:inspect');
    ipcMain.removeHandler('workbench:inspect');
    ipcMain.handle('workbench:inspect', async (...args) => {
      globalThis.accessReads++;
      const f = fixtures.find((f) => f.id === args[2]);
      if (!f) return inspect(...args);
      const fresh = structuredClone(f);
      if (f.id === 'access-owner' && globalThis.revokeOwner) fresh.ownedByMe = false;
      if (f.id === 'access-editor' && globalThis.revokeShare) fresh.capabilities.canShare = false;
      if (f.id === 'access-unknown') fresh.capabilities = { ...caps };
      return fresh;
    });
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.locator('.scan-summary').waitFor();
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('校验-');
  const panel = page.locator('.operations-console'),
    button = (name) => panel.getByRole('button', { name, exact: true });
  const choose = async (name) => {
    if (await button('清空选择').count()) await button('清空选择').click();
    await page.getByRole('checkbox', { name: '选择 ' + name, exact: true }).check();
  };
  await choose('校验-查看者');
  for (const name of [
    '转让所有权',
    '添加多个邮箱',
    '修改邮箱角色',
    '移除指定邮箱',
    '替换协作者名单',
    '开启链接访问',
    '关闭链接访问',
    '移除群组共享',
    '移除域共享',
    '编辑者分享限制',
    '复制与下载限制',
    '高级组合设置',
    '重命名',
    '移动',
    '副本',
    '删除',
  ])
    if (!(await button(name).isDisabled())) throw Error('查看者操作未禁用：' + name);
  if (await button('复制链接').isDisabled()) throw Error('查看者不能复制链接');
  await button('复制链接').click();
  if (!(await app.evaluate(({ clipboard }) => clipboard.readText())).includes('access-viewer'))
    throw Error('查看者链接复制失败');
  await page.locator('tr[data-file-id="access-viewer"]').click({ button: 'right' });
  if (
    !(await page
      .locator('.context-menu')
      .getByRole('button', { name: '转让所有权', exact: true })
      .isDisabled())
  )
    throw Error('右键绕过校验');
  await page.keyboard.press('Escape');
  await choose('校验-编辑者');
  if (
    !(await button('转让所有权').isDisabled()) ||
    !(await button('删除').isDisabled()) ||
    !(await button('移动').isDisabled())
  )
    throw Error('编辑者能力判断错误');
  if (
    (await button('添加多个邮箱').isDisabled()) ||
    (await button('重命名').isDisabled()) ||
    (await button('副本').isDisabled())
  )
    throw Error('错误阻止编辑者合法操作');
  if (
    !(await button('编辑者分享限制').isDisabled()) ||
    !(await button('复制与下载限制').isDisabled())
  )
    throw Error('分享管理越过限制设置权限');
  await app.evaluate(() => {
    globalThis.revokeShare = true;
  });
  await button('添加多个邮箱').click();
  await page.waitForFunction(
    () => !document.querySelector('.operations-console .refresh-operation-access').disabled,
  );
  if (await page.getByRole('dialog').count()) throw Error('失去分享权限仍打开操作表单');
  if (!(await button('添加多个邮箱').isDisabled())) throw Error('重新校验未更新按钮');
  await choose('校验-所有者');
  if (await button('转让所有权').isDisabled()) throw Error('所有者转让被阻止');
  await page.getByRole('checkbox', { name: '选择 校验-编辑者', exact: true }).check();
  if (!(await button('转让所有权').isDisabled())) throw Error('混合选择未禁用转让');
  if (!(await button('转让所有权').getAttribute('title')).includes('不能执行'))
    throw Error('没有不可用原因');
  await choose('校验-所有者');
  await app.evaluate(() => {
    globalThis.revokeOwner = true;
  });
  await button('转让所有权').click();
  await page.waitForFunction(
    () => !document.querySelector('.operations-console .refresh-operation-access').disabled,
  );
  if (await page.getByRole('dialog').count()) throw Error('所有权变化后仍打开转让表单');
  if (!(await button('转让所有权').isDisabled())) throw Error('所有权变化未更新按钮');
  await choose('校验-未知权限');
  if (!(await button('重命名').isDisabled())) throw Error('未知权限冒充可操作');
  await button('刷新操作权限').click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.operations-console button')].find(
        (e) => e.textContent.trim() === '重命名',
      ).disabled,
  );
  await button('重命名').click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await choose('校验-查看者');
  await page.screenshot({ path: 'test-results/18-action-access.png' });
  if (errors.length) throw Error(errors.join('\n'));
  const checks = [
    'viewer mutations disabled; link copy allowed',
    'editor allowed actions based on capabilities',
    'ownership transfer requires owner',
    'restriction settings checked separately',
    'context menus match console',
    'mixed selection disables entire action with reason',
    'fresh preflight blocks revoked sharing/ownership',
    'unknown permissions require refresh',
  ];
  await writeFile(
    'test-results/access-results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Access UI passed:', checks.join('; '));
} finally {
  await app.close();
}
