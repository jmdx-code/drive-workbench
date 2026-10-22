import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
export async function ensureElectronRuntime(root) {
  try {
    await access(path.join(root, 'node_modules/electron/dist'));
  } catch {
    execFileSync(process.execPath, [path.join(root, 'node_modules/electron/install.js')], {
      stdio: 'inherit',
      windowsHide: true,
    });
  }
}
