import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-update-ui-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : { args: ['.'] }),
  env,
  timeout: 45000,
});
try {
  const page = await app.firstWindow();
  await app.evaluate(({ ipcMain, BrowserWindow, app }) => {
    BrowserWindow.getAllWindows()[0].showInactive();
    const original = ipcMain._invokeHandlers.get('workbench:bootstrap');
    globalThis.qaUpdate = { status: 'idle', current: app.getVersion() };
    globalThis.qaInstalled = 0;
    ipcMain._invokeHandlers.set('workbench:bootstrap', async (...args) => ({
      ...(await original(...args)),
      update: globalThis.qaUpdate,
    }));
    ipcMain._invokeHandlers.set('workbench:checkUpdate', async () => {
      globalThis.qaUpdate = {
        status: 'ready',
        current: app.getVersion(),
        latest: '9.0.0',
        percent: 100,
      };
    });
    ipcMain._invokeHandlers.set('workbench:installUpdate', async () => {
      globalThis.qaInstalled++;
    });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '并发与执行设置', exact: true });
  await settings.getByRole('button', { name: '检查更新', exact: true }).click();
  await settings.getByRole('button', { name: '重启并更新', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '重启并更新软件', exact: true });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  if ((await app.evaluate(() => globalThis.qaInstalled)) !== 0)
    throw Error('Cancel triggered install');
  await settings.getByRole('button', { name: '重启并更新', exact: true }).click();
  await page.setViewportSize({ width: 1050, height: 720 });
  await mkdir('test-results/updater', { recursive: true });
  await page.screenshot({ path: 'test-results/updater/confirmation.png' });
  await confirm.getByRole('button', { name: '确认重启更新', exact: true }).click();
  if ((await app.evaluate(() => globalThis.qaInstalled)) !== 1)
    throw Error('Confirmation did not invoke install');
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/updater/ui.json',
    JSON.stringify(
      {
        passed: true,
        errors,
        checks: [
          'check update entry',
          'ready version',
          'cancel without install',
          'explicit restart confirmation',
          '1050px layout',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Portable update UI passed');
} finally {
  await app.close();
}
