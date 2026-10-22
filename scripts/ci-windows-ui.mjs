import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const manifest = JSON.parse(await readFile('release/当前版本.json', 'utf8'));
const executable = path.resolve('release', manifest.executable);
for (const script of [
  'ui-test',
  'data-avatar-ui-test',
  'api-concurrency-ui-test',
  'transfer-root-ui-test',
  'skip-transfer-ui-test',
  'update-ui-test',
])
  execFileSync(process.execPath, [`scripts/${script}.mjs`, executable], {
    stdio: 'inherit',
    windowsHide: true,
  });
