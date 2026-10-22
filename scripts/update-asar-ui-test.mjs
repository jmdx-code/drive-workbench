// Exercise the real packaged installUpdate IPC in Electron. Stop after helper
// preparation: do not replace the application or access the user's profile.
import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const fixture = await mkdtemp(path.join(tmpdir(), 'drive-asar-update-'));
const manifest = JSON.parse(await readFile('release/当前版本.json', 'utf8'));
const env = { ...process.env, WB_QA_DIR: path.join(fixture, 'profile'), WB_QA_LIVE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve(process.argv[2] || path.join('release', manifest.executable)),
  env,
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  // firstWindow() only waits for window creation. Closing before loadFile()
  // finishes can trigger an unrelated startup ERR_FAILED dialog.
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  const setup = await app.evaluate(async ({ app }, fixture) => {
    const require = process
      .getBuiltinModule('node:module')
      .createRequire(app.getAppPath() + '/package.json');
    const fs = require('node:fs/promises'),
      original = require('original-fs');
    const path = require('node:path'),
      crypto = require('node:crypto');
    const archive = app.getAppPath();
    if (!app.isPackaged || !archive.endsWith('.asar'))
      throw Error('Requires a real packaged ASAR app');
    const physicalFile = (await original.promises.stat(archive)).isFile();
    let legacyError;
    try {
      await fs.access(archive);
    } catch (error) {
      legacyError = String(error);
    }
    const file = path.join(fixture, 'fixture.zip'),
      bytes = Buffer.from('fixture update bytes');
    await fs.writeFile(file, bytes);
    const { PortableUpdater } = require(path.join(archive, 'dist-desktop/core/updater.js'));
    const prepare = PortableUpdater.prototype.prepareInstall;
    PortableUpdater.prototype.prepareInstall = async function (pid) {
      // Normally download() creates this directory before marking the update ready.
      await fs.mkdir(this.options.cacheDir, { recursive: true });
      this.state.status = 'ready';
      this.ready = {
        file,
        version: '9.0.0',
        size: bytes.length,
        checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
      const helper = await prepare.call(this, pid);
      globalThis.qaAsarHelperPrepared = !!helper.command && helper.args.length > 0;
      // Throw before main.ts can spawn the helper or quit the application.
      throw Error('QA_ASAR_HELPER_PREPARED_NO_INSTALL');
    };
    return { physicalFile, legacyError, platform: process.platform, version: app.getVersion() };
  }, fixture);
  assert.equal(setup.physicalFile, true);
  assert.match(setup.legacyError || '', /ENOENT/);
  const result = await page.evaluate(async () => {
    try {
      await window.workbench.installUpdate();
      return '';
    } catch (error) {
      return String(error);
    }
  });
  assert.match(result, /QA_ASAR_HELPER_PREPARED_NO_INSTALL/);
  assert.equal(await app.evaluate(() => globalThis.qaAsarHelperPrepared), true);
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await mkdir('test-results/updater', { recursive: true });
  await writeFile(
    'test-results/updater/asar.json',
    JSON.stringify(
      {
        passed: true,
        ...setup,
        installUpdateIpcPreparedHelper: true,
        installerExecuted: false,
      },
      null,
      2,
    ),
  );
  console.log('Packaged ASAR update IPC passed:', setup.platform, setup.version);
} finally {
  await app.close();
}
