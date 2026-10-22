import { _electron as electron } from 'playwright-core';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const manifest = JSON.parse(await readFile('release/当前版本.json', 'utf8'));
const env = {
  ...process.env,
  WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-portable-')),
  WB_QA_LIVE: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve('release', manifest.executable),
  env,
  timeout: 60000,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('连接你的第一个账号', { exact: true }).waitFor();
  const result = await app.evaluate(({ app, safeStorage }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    encryption:
      safeStorage.isEncryptionAvailable() &&
      safeStorage.decryptString(safeStorage.encryptString('fixture')) === 'fixture',
  }));
  if (result.version !== manifest.version || !result.packaged || !result.encryption)
    throw Error(JSON.stringify(result));
  const boot = await page.evaluate(() => window.workbench.bootstrap());
  if (
    boot.mode !== 'live' ||
    boot.accounts.length ||
    boot.tasks.length ||
    boot.update.current !== manifest.version
  )
    throw Error('Invalid packaged bootstrap');
  await mkdir('test-results/portable', { recursive: true });
  await page.screenshot({ path: 'test-results/portable/first-launch.png' });
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/portable/results.json',
    JSON.stringify(
      { passed: true, ...result, platform: process.platform, arch: process.arch },
      null,
      2,
    ),
  );
  console.log('Portable smoke passed:', process.platform, process.arch, JSON.stringify(result));
} finally {
  await app.close();
}
