import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateState } from './types.js';

export const RELEASE_API = 'https://api.github.com/repos/jmdx-code/drive-workbench/releases/latest';
const githubUrl = (raw: string) => {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    ![
      'api.github.com',
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ].includes(u.hostname)
  )
    throw Error('更新地址不属于 GitHub');
  return u.href;
};
async function request(raw: string, signal: AbortSignal) {
  let url = githubUrl(raw);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'DriveWorkbench' },
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      await r.body?.cancel();
      url = githubUrl(new URL(r.headers.get('location') || '', url).href);
    } else {
      if (!r.ok) {
        await r.body?.cancel();
        throw Error(`更新服务暂不可用（HTTP ${r.status}）`);
      }
      return r;
    }
  }
  throw Error('更新服务重定向过多');
}
async function smallText(url: string) {
  const r = await request(url, AbortSignal.timeout(20000));
  const reader = r.body?.getReader();
  if (!reader) throw Error('更新信息为空');
  let result = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      if (result.length > 1024 * 1024) throw Error('更新信息过大');
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
export async function sha256File(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export function newerVersion(candidate: string, current: string) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const a = candidate.split('.').map(Number),
    b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export type Helper = { command: string; args: string[]; cwd: string };
export class PortableUpdater {
  state: UpdateState;
  private pending?: Promise<void>;
  private ready?: { file: string; version: string; checksum: string };
  constructor(
    private options: {
      version: string;
      platform: string;
      arch: string;
      packaged: boolean;
      appRoot: string;
      cacheDir: string;
    },
  ) {
    this.state = {
      current: options.version,
      status:
        options.packaged &&
        ['win32', 'darwin'].includes(options.platform) &&
        ['x64', 'arm64'].includes(options.arch)
          ? 'idle'
          : 'unsupported',
    };
  }
  check() {
    if (this.pending) return this.pending;
    if (['unsupported', 'installing', 'ready'].includes(this.state.status))
      return Promise.resolve();
    this.pending = this.download()
      .catch((e) => {
        this.state = {
          ...this.state,
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        };
      })
      .finally(() => (this.pending = undefined));
    return this.pending;
  }
  private async download() {
    this.state = { current: this.options.version, status: 'checking' };
    const release = JSON.parse(await smallText(RELEASE_API)) as {
      tag_name: string;
      draft?: boolean;
      prerelease?: boolean;
      assets: { name: string; browser_download_url: string }[];
    };
    const version = release.tag_name?.replace(/^v/, '');
    if (release.draft || release.prerelease || !newerVersion(version, this.options.version)) {
      this.state.status = 'idle';
      return;
    }
    const platform = this.options.platform === 'win32' ? 'Windows' : 'macOS';
    const name = `DriveWorkbench-${version}-${platform}-${this.options.arch}.zip`;
    const asset = release.assets.find((a) => a.name === name),
      sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
    if (!asset || !sums) throw Error('新版本仍在构建，请稍后检查更新');
    const lines = (await smallText(sums.browser_download_url)).split(/\r?\n/);
    const matches = lines
      .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
      .filter((m) => m?.[2] === name);
    if (matches.length !== 1) throw Error('更新包校验信息缺失或重复');
    const checksum = matches[0]![1].toLowerCase();
    await mkdir(this.options.cacheDir, { recursive: true });
    const file = path.join(this.options.cacheDir, name);
    const cached = await sha256File(file).catch(() => '');
    if (cached !== checksum) {
      this.state = {
        current: this.options.version,
        latest: version,
        status: 'downloading',
        percent: 0,
      };
      const response = await request(asset.browser_download_url, AbortSignal.timeout(600000));
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body?.getReader();
      if (!reader) throw Error('更新包为空');
      const part = file + '.part';
      const handle = await open(part, 'w');
      const hash = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 ** 3) throw Error('更新包超过大小限制');
          hash.update(value);
          await handle.writeFile(value);
          this.state.percent = total ? Math.min(99, Math.floor((size / total) * 100)) : undefined;
        }
      } finally {
        await reader.cancel();
        await handle.close();
      }
      if (hash.digest('hex') !== checksum) throw Error('更新包 SHA256 校验失败，未安装');
      await rename(part, file);
    }
    this.ready = { file, version, checksum };
    this.state = { current: this.options.version, latest: version, status: 'ready', percent: 100 };
  }
  async prepareInstall(pid: number): Promise<Helper> {
    if (!this.ready || this.state.status !== 'ready') throw Error('更新包尚未下载完成');
    if ((await sha256File(this.ready.file)) !== this.ready.checksum)
      throw Error('更新包已变化，请重新检查更新');
    const root = path.resolve(this.options.appRoot);
    if (root === path.parse(root).root) throw Error('应用路径无效');
    await access(
      path.join(
        root,
        this.options.platform === 'win32' ? 'resources/app.asar' : 'Contents/Resources/app.asar',
      ),
    );
    const backup = `${root}.backup-${this.options.version}-${randomUUID().slice(0, 8)}`;
    const staging = path.join(this.options.cacheDir, 'unpacked-' + randomUUID());
    await mkdir(staging);
    const log = path.join(this.options.cacheDir, 'update.log');
    this.state.status = 'installing';
    if (this.options.platform === 'win32') {
      const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
      const extracted = path.join(
        staging,
        `DriveWorkbench-${this.ready.version}-Windows-${this.options.arch}`,
      );
      const script = `$ErrorActionPreference='Stop'\n$root=${quote(root)}\n$backup=${quote(backup)}\n$new=${quote(extracted)}\ntry {\n Wait-Process -Id ${pid} -ErrorAction SilentlyContinue\n Start-Sleep -Seconds 2\n Expand-Archive -LiteralPath ${quote(this.ready.file)} -DestinationPath ${quote(staging)}\n if (!(Test-Path -LiteralPath (Join-Path $new 'resources/app.asar')) -or !(Test-Path -LiteralPath (Join-Path $new '云盘工作台.exe'))) { throw 'Invalid update package' }\n $moved=$false\n for ($i=0;$i -lt 15;$i++) { try { Move-Item -LiteralPath $root -Destination $backup -ErrorAction Stop; $moved=$true; break } catch { Start-Sleep -Seconds 1 } }\n if (!$moved) { throw 'Application directory is busy or read-only' }\n Move-Item -LiteralPath $new -Destination $root\n Start-Process -FilePath (Join-Path $root '云盘工作台.exe') -WorkingDirectory $root\n 'Updated successfully' | Set-Content -LiteralPath ${quote(log)}\n} catch {\n $_ | Out-String | Set-Content -LiteralPath ${quote(log)}\n if ((Test-Path -LiteralPath $backup) -and !(Test-Path -LiteralPath $root)) { Move-Item -LiteralPath $backup -Destination $root }\n if (Test-Path -LiteralPath (Join-Path $root '云盘工作台.exe')) { Start-Process -FilePath (Join-Path $root '云盘工作台.exe') -WorkingDirectory $root }\n}\n`;
      const helper = path.join(this.options.cacheDir, 'apply-update.ps1');
      await writeFile(helper, script, 'utf8');
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        cwd: this.options.cacheDir,
      };
    }
    const helper = path.join(this.options.cacheDir, 'apply-update.sh');
    await writeFile(
      helper,
      '#!/bin/bash\nset -eu\npid="$1"; current="$2"; backup="$3"; zip="$4"; staging="$5"; next="$6"; log="$7"\nexec >>"$log" 2>&1\nwhile kill -0 "$pid" 2>/dev/null; do sleep 1; done\nsleep 2\n/usr/bin/ditto -x -k "$zip" "$staging"\ntest -f "$next/Contents/Resources/app.asar"\n/usr/bin/codesign --verify --deep --strict "$next"\n/bin/mv "$current" "$backup"\nif ! /bin/mv "$next" "$current"; then /bin/mv "$backup" "$current"; /usr/bin/open "$current"; exit 1; fi\n/usr/bin/open "$current"\n',
      { mode: 0o700 },
    );
    return {
      command: '/bin/bash',
      args: [
        helper,
        String(pid),
        root,
        backup,
        this.ready.file,
        staging,
        path.join(staging, `云盘工作台-darwin-${this.options.arch}`, '云盘工作台.app'),
        log,
      ],
      cwd: this.options.cacheDir,
    };
  }
}
