import { readFile, access, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { listPackage, extractFile } from '@electron/asar';
import path from 'node:path';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('release/当前版本.json', 'utf8'));
if (manifest.version !== pkg.version) throw Error('Release manifest version mismatch');
const output = path.resolve('release', manifest.directory),
  archive = path.join(output, 'resources/app.asar');
await access(path.resolve('release', manifest.executable));
const executable = await readFile(path.resolve('release', manifest.executable));
const pe = NtExecutable.from(executable);
const resources = NtExecutableResource.from(pe);
const versions = Resource.VersionInfo.fromEntries(resources.entries);
if (
  !versions.some((version) =>
    version.getAllLanguagesForStringValues().some((language) => {
      const values = version.getStringValues(language);
      return (
        values.ProductName === '云盘工作台' &&
        values.OriginalFilename === '云盘工作台.exe' &&
        values.FileVersion === pkg.version + '.0' &&
        values.ProductVersion === pkg.version + '.0'
      );
    }),
  )
)
  throw Error('EXE product name or file/product version resources mismatch');
const icon = await readFile('assets/branding/app-icon.ico');
if (icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) !== 7)
  throw Error('Expected seven Windows icon sizes');
for (let i = 0; i < 7; i++) {
  const entry = 6 + i * 16;
  const length = icon.readUInt32LE(entry + 8),
    offset = icon.readUInt32LE(entry + 12);
  if (!executable.includes(icon.subarray(offset, offset + length)))
    throw Error('Executable is missing embedded icon size ' + (icon[entry] || 256));
}
const hash = (data) => createHash('sha256').update(data).digest('hex');
if (hash(await readFile(path.resolve('release', manifest.archive))) !== manifest.sha256)
  throw Error('ZIP checksum mismatch');
const files = listPackage(archive).map((p) => p.replaceAll('\\', '/').replace(/^\//, ''));
const unexpected = files.filter(
  (p) => !['dist', 'dist-desktop', 'package.json'].includes(p.split('/')[0]),
);
if (unexpected.length) throw Error('Unexpected ASAR content: ' + unexpected.join(', '));
if (
  files.some((p) =>
    /(^|\/)(tests|test-results|scripts|backups|node_modules|参考[^/]*)(\/|$)/.test(p),
  )
)
  throw Error('Development files included in ASAR');
const appPkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
if (
  appPkg.version !== pkg.version ||
  appPkg.productName !== '云盘工作台' ||
  appPkg.main !== pkg.main
)
  throw Error('Packaged application identity mismatch');
let checked = 0;
for (const dir of ['dist', 'dist-desktop']) {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name),
      relative = path.relative(process.cwd(), absolute).replaceAll('\\', '/');
    if (hash(await readFile(absolute)) !== hash(extractFile(archive, path.normalize(relative))))
      throw Error('Stale packaged file: ' + relative);
    checked++;
  }
}
const top = await readdir(output);
if (top.some((p) => /测试|参考|验收|backups|node_modules/.test(p)))
  throw Error('Development material included in deliverable');
await access(path.join(output, '使用说明.md'));
await access(path.join(output, 'LICENSE'));
await access(path.join(output, 'LICENSES.chromium.html'));
await access(path.join(output, 'licenses/react.txt'));
await mkdir('test-results/production-packaged', { recursive: true });
const result = {
  passed: true,
  version: pkg.version,
  compiledFilesVerified: checked,
  checks: [
    'ZIP SHA256',
    'seven icon resolutions embedded in Windows executable',
    'current release pointer',
    'package identity and version',
    'all compiled files identical to current build',
    'no test scripts, reference projects, backups or development dependencies in ASAR',
    'clean delivery directory',
    'runtime licenses and user guide retained',
  ],
};
await writeFile('test-results/production-packaged/integrity.json', JSON.stringify(result, null, 2));
console.log('Package integrity passed:', JSON.stringify(result));
