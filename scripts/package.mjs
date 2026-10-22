import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { brandExecutable } from './branding.mjs';
if (process.platform === 'darwin') {
  await import('./package-mac.mjs');
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('请在 Windows x64 或 macOS 原生 runner 上打包');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const base = `DriveWorkbench-${pkg.version}-Windows-x64`;
const releaseRoot = path.resolve(root, 'release');
const output = path.join(releaseRoot, base);
await mkdir(output, { recursive: true });
// A fresh staging folder prevents stale files from earlier releases entering ASAR.
const staging = await mkdtemp(path.join(releaseRoot, '.staging-'));
await cp(path.join(root, 'node_modules/electron/dist'), output, {
  recursive: true,
  filter: (source) => path.basename(source) !== 'default_app.asar',
});
await cp(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
await cp(path.join(root, 'dist-desktop'), path.join(staging, 'dist-desktop'), { recursive: true });
await writeFile(
  path.join(staging, 'package.json'),
  JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    main: pkg.main,
    productName: '云盘工作台',
  }),
);
await createPackage(staging, path.join(output, 'resources', 'app.asar'));
await rename(path.join(output, 'electron.exe'), path.join(output, '云盘工作台.exe'));
await brandExecutable(path.join(output, '云盘工作台.exe'));
await cp(path.join(root, 'docs/正式版使用说明.md'), path.join(output, '使用说明.md'));
await cp(path.join(root, 'docs/第三方许可.md'), path.join(output, '第三方许可.md'));
await mkdir(path.join(output, 'licenses'), { recursive: true });
for (const name of [
  'react',
  'react-dom',
  'lucide-react',
  '@tanstack/react-virtual',
  '@tanstack/virtual-core',
]) {
  const license = await readFile(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8');
  await writeFile(path.join(output, 'licenses', `${name.replaceAll('/', '-')}.txt`), license);
}
const zip = path.join(root, 'release', `${base}.zip`);
const quote = (s) => s.replace(/'/g, "''");
const cmd = `$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath '${quote(output)}' -DestinationPath '${quote(zip)}' -Force`;
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')],
  { stdio: 'inherit', windowsHide: true },
);
const sha256 = createHash('sha256')
  .update(await readFile(zip))
  .digest('hex');
await writeFile(
  path.join(releaseRoot, `SHA256SUMS-${pkg.version}.txt`),
  `${sha256}  ${base}.zip\n`,
);
await writeFile(
  path.join(releaseRoot, '当前版本.json'),
  JSON.stringify(
    {
      version: pkg.version,
      directory: base,
      executable: `${base}/云盘工作台.exe`,
      archive: `${base}.zip`,
      sha256,
    },
    null,
    2,
  ),
);
if (path.dirname(staging) !== releaseRoot || !path.basename(staging).startsWith('.staging-'))
  throw new Error('临时打包目录超出 release，拒绝清理');
await rm(staging, { recursive: true, force: true });
console.log(`Portable application: ${output}\nZIP: ${zip}`);
