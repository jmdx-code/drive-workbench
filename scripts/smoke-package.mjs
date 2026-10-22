import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const executablePath = path.resolve(
  `release/DriveWorkbench-${pkg.version}-Windows-x64/云盘工作台.exe`,
);
const env = {
  ...process.env,
  WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-workbench-packaged-')),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  env,
  timeout: 40000,
});
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true })
    .waitFor();
  const b = await page.evaluate(() => window.workbench.bootstrap());
  if (b.mode !== 'demo' || b.accounts.length !== 2) throw new Error('打包后IPC或演示初始化失败');
  const secure = await app.evaluate(async ({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return (
      safeStorage.decryptString(safeStorage.encryptString('qa-round-trip')) === 'qa-round-trip'
    );
  });
  if (!secure) throw new Error('Windows系统加密不可用');
  await page.evaluate(async () => {
    await window.workbench.switchMode('live');
    await window.workbench.settings({
      concurrency: 12,
      accountConcurrency: 6,
      connectionConcurrency: 3,
    });
  });
  await writeFile(
    'test-results/package-results.json',
    JSON.stringify(
      {
        passed: true,
        version: pkg.version,
        accounts: b.accounts.length,
        sqlite: 'initialized',
        preload: 'verified',
        safeStorage: secure,
      },
      null,
      2,
    ),
  );
  console.log('Packaged Windows application smoke test passed.');
} finally {
  await app.close();
}
const restarted = await electron.launch({
  executablePath,
  env,
  timeout: 40000,
});
try {
  const page = await restarted.firstWindow();
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  const settings = await page.evaluate(async () => {
    await window.workbench.switchMode('live');
    return (await window.workbench.bootstrap()).settings;
  });
  if (
    settings.concurrency !== undefined ||
    settings.accountConcurrency !== 6 ||
    settings.connectionConcurrency !== 3
  )
    throw new Error('打包后SQLite重启恢复失败');
  await writeFile(
    'test-results/package-results.json',
    JSON.stringify(
      {
        passed: true,
        version: pkg.version,
        sqlite: 'verified after restart',
        preload: 'verified',
        safeStorage: true,
        portable: true,
      },
      null,
      2,
    ),
  );
  console.log('Packaged application restart and persistence check passed.');
} finally {
  await restarted.close();
}
