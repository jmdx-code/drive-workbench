// Applies a real Windows portable ZIP to an isolated fixture directory.
// Never targets the user's running application or account profile.
import { mkdtemp, mkdir, writeFile, readFile, cp, readdir, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { extractFile } from '@electron/asar';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PortableUpdater } from '../dist-desktop/core/updater.js';
if (process.platform !== 'win32') throw Error('Windows fixture test');
const manifest = JSON.parse(await readFile('release/当前版本.json', 'utf8'));
const fixture = await mkdtemp(path.join(tmpdir(), 'drive-update-apply-'));
const appRoot = path.join(fixture, 'portable app'),
  cacheDir = path.join(fixture, 'updates'),
  profile = path.join(fixture, 'profile');
await mkdir(path.join(appRoot, 'resources'), { recursive: true });
await mkdir(cacheDir);
await mkdir(profile);
await writeFile(path.join(appRoot, 'resources/app.asar'), 'old fixture');
await writeFile(path.join(appRoot, 'old-marker.txt'), 'preserve old app');
await writeFile(path.join(profile, 'user-data-marker.txt'), 'preserve accounts');
await cp(path.resolve('release', manifest.archive), path.join(cacheDir, manifest.archive));
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signedRaw = JSON.stringify({
  schema: 1,
  version: manifest.version,
  assets: [
    {
      name: manifest.archive,
      platform: 'win32',
      arch: 'x64',
      size: (await stat(path.join(cacheDir, manifest.archive))).size,
      sha256: manifest.sha256,
    },
  ],
});
const signature = sign(null, Buffer.from(signedRaw), privateKey).toString('hex');
globalThis.fetch = async (url) =>
  String(url).endsWith('/latest')
    ? new Response(
        JSON.stringify({
          tag_name: 'v' + manifest.version,
          assets: [
            {
              name: manifest.archive,
              browser_download_url: 'https://github.com/fixture/package.zip',
            },
            {
              name: 'UPDATE-MANIFEST.json',
              browser_download_url: 'https://github.com/fixture/manifest',
            },
            {
              name: 'UPDATE-MANIFEST.sig',
              browser_download_url: 'https://github.com/fixture/signature',
            },
          ],
        }),
      )
    : new Response(String(url).endsWith('/manifest') ? signedRaw : signature);
const updater = new PortableUpdater({
  version: '1.3.2',
  platform: 'win32',
  arch: 'x64',
  packaged: true,
  appRoot,
  cacheDir,
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
});
await updater.check();
if (updater.state.status !== 'ready') throw Error(JSON.stringify(updater.state));
const guard = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
const helper = await updater.prepareInstall(guard.pid);
const env = { ...process.env, WB_QA_DIR: profile, WB_QA_LIVE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(helper.command, helper.args, { cwd: helper.cwd, env, windowsHide: true });
guard.kill();
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
if (code !== 0) throw Error('Update helper exited ' + code);
const deadline = Date.now() + 30000;
let started = false;
while (Date.now() < deadline) {
  try {
    await access(path.join(profile, 'workbench.sqlite'));
    started = true;
    break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const executable = path.join(appRoot, '云盘工作台.exe');
const ps = `$target='${executable.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
  { windowsHide: true },
);
if (!started)
  throw Error(
    'Updated application did not start: ' +
      (await readFile(path.join(cacheDir, 'update.log'), 'utf8')),
  );
const installed = JSON.parse(extractFile(path.join(appRoot, 'resources/app.asar'), 'package.json'));
if (installed.version !== manifest.version) throw Error('Incorrect installed version');
const backup = (await readdir(fixture)).find((name) => name.startsWith('portable app.backup-'));
if (
  !backup ||
  (await readFile(path.join(fixture, backup, 'old-marker.txt'), 'utf8')) !== 'preserve old app'
)
  throw Error('Backup missing');
if ((await readFile(path.join(profile, 'user-data-marker.txt'), 'utf8')) !== 'preserve accounts')
  throw Error('Profile modified');
await mkdir('test-results/updater', { recursive: true });
await writeFile(
  'test-results/updater/install.json',
  JSON.stringify(
    {
      passed: true,
      version: installed.version,
      fixture,
      checks: [
        'verified ZIP',
        'wait for old process',
        'replace portable folder',
        'updated app launches',
        'user profile preserved',
        'old folder preserved',
      ],
    },
    null,
    2,
  ),
);
console.log('Portable self-update install passed:', installed.version);
