import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packager } from '@electron/packager';
if (process.platform !== 'darwin') throw Error('macOS 打包必须在 Mac runner 上运行');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
const staging = await mkdtemp(path.join(release, '.staging-'));
const base = `DriveWorkbench-${pkg.version}-macOS-${process.arch}`;
try {
  for (const dir of ['dist', 'dist-desktop'])
    await cp(path.join(root, dir), path.join(staging, dir), { recursive: true });
  await writeFile(
    path.join(staging, 'package.json'),
    JSON.stringify({
      name: pkg.name,
      productName: '云盘工作台',
      version: pkg.version,
      type: 'module',
      main: pkg.main,
    }),
  );
  const [output] = await packager({
    dir: staging,
    out: release,
    name: '云盘工作台',
    executableName: 'DriveWorkbench',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: pkg.devDependencies.electron,
    appBundleId: 'com.driveworkbench.desktop',
    appVersion: pkg.version,
    icon: path.join(root, 'assets/branding/app-icon.icns'),
    asar: true,
    prune: false,
    overwrite: true,
    osxSign: {
      identity: '-',
      identityValidation: false,
      gatekeeperAssess: false,
      preAutoEntitlements: false,
      continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  });
  await cp(path.join(root, 'docs/正式版使用说明.md'), path.join(output, '使用说明.md'));
  await cp(path.join(root, 'docs/第三方许可.md'), path.join(output, '第三方许可.md'));
  await mkdir(path.join(output, 'licenses'), { recursive: true });
  for (const name of [
    'react',
    'react-dom',
    'lucide-react',
    '@tanstack/react-virtual',
    '@tanstack/virtual-core',
  ])
    await cp(
      path.join(root, 'node_modules', name, 'LICENSE'),
      path.join(output, 'licenses', name.replaceAll('/', '-') + '.txt'),
    );
  const app = path.join(output, '云盘工作台.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const zip = path.join(release, `${base}.zip`);
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', output, zip]);
  const sha = createHash('sha256')
    .update(await readFile(zip))
    .digest('hex');
  await writeFile(
    path.join(release, `SHA256SUMS-${pkg.version}-macOS-${process.arch}.txt`),
    `${sha}  ${base}.zip\n`,
  );
  await writeFile(
    path.join(release, '当前版本.json'),
    JSON.stringify(
      {
        version: pkg.version,
        directory: path.basename(output),
        executable: path.relative(release, path.join(app, 'Contents/MacOS/DriveWorkbench')),
        archive: path.basename(zip),
        sha256: sha,
      },
      null,
      2,
    ),
  );
  console.log('macOS portable ZIP:', zip);
} finally {
  if (path.dirname(staging) !== release || !path.basename(staging).startsWith('.staging-'))
    throw Error('Invalid staging directory');
  await rm(staging, { recursive: true, force: true });
}
