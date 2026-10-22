import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-security-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: ['--dev'] }
    : { args: ['.'] }),
  env,
  timeout: 45000,
});
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  assert.ok(page.url().startsWith('file:'), 'packaged --dev must still load local production HTML');
  const result = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const handler = ipcMain._invokeHandlers.get('workbench:bootstrap');
    const invoke = (sender, senderFrame) => handler({ sender, senderFrame });
    const valid = (await invoke(contents, contents.mainFrame)).mode === 'demo';
    let denied = 0;
    for (const [sender, frame] of [
      [contents, undefined],
      [contents, { url: contents.getURL() }],
      [{}, contents.mainFrame],
      [contents, { url: 'https://attacker.example' }],
    ]) {
      try {
        await invoke(sender, frame);
      } catch {
        denied++;
      }
    }
    const preferences = contents.getLastWebPreferences();
    return {
      valid,
      denied,
      isolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
    };
  });
  assert.deepEqual(result, {
    valid: true,
    denied: 4,
    isolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  assert.equal(
    await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
    ),
    'denied',
  );
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  assert.ok(csp.includes("frame-src 'none'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.ok(!csp.includes('ws://'));
  console.log(
    'Security UI passed: main-frame IPC, sender rejection, sandbox, permission denial, production CSP.',
  );
} finally {
  await app.close();
}
