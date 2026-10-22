import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PortableUpdater, newerVersion } from '../core/updater.js';
afterEach(() => vi.unstubAllGlobals());
async function setup(platform = 'win32', arch = 'x64') {
  const dir = await mkdtemp(path.join(tmpdir(), 'drive-update-unit-'));
  const options = {
    version: '1.3.2',
    platform,
    arch,
    packaged: true,
    appRoot: path.join(dir, "app's folder"),
    cacheDir: path.join(dir, 'cache'),
  };
  const bytes = Buffer.from('fixture zip');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const name = `DriveWorkbench-1.3.3-${platform === 'win32' ? 'Windows' : 'macOS'}-${arch}.zip`;
  const sums = `https://github.com/jmdx-code/drive-workbench/releases/download/v1.3.3/SHA256SUMS.txt`;
  const zip = `https://github.com/jmdx-code/drive-workbench/releases/download/v1.3.3/${name}`;
  const release = {
    tag_name: 'v1.3.3',
    assets: [
      { name, browser_download_url: zip },
      { name: 'SHA256SUMS.txt', browser_download_url: sums },
    ],
  };
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return url.endsWith('/latest')
      ? new Response(JSON.stringify(release))
      : url === sums
        ? new Response(`${hash}  ${name}\n`)
        : new Response(bytes);
  });
  return { updater: new PortableUpdater(options), options, bytes, hash, name, release, requests };
}
describe('便携版自动更新', () => {
  it('严格比较稳定版本，不接受预发布、降级和路径注入', () => {
    expect(newerVersion('1.10.0', '1.9.9')).toBe(true);
    for (const version of ['1.3.2', '1.2.9', '1.3.3-beta.1', '1.3.3/../../x'])
      expect(newerVersion(version, '1.3.2')).toBe(false);
  });
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ])
    it(`${platform}/${arch}: 选择正确包，校验 SHA256，合并请求并复用下载缓存`, async () => {
      const { updater, requests, options, bytes, name } = await setup(platform, arch);
      await Promise.all([updater.check(), updater.check()]);
      expect(updater.state.status).toBe('ready');
      expect(requests).toHaveLength(3);
      expect(await readFile(path.join(options.cacheDir, name))).toEqual(bytes);
      await new PortableUpdater(options).check();
      expect(requests).toHaveLength(5);
    });
  it('旧版本不下载，新发布但缺少完整资产时不更新', async () => {
    const { updater, release, requests } = await setup();
    release.tag_name = 'v1.3.1';
    await updater.check();
    expect(updater.state.status).toBe('idle');
    expect(requests).toHaveLength(1);
    release.tag_name = 'v1.3.3';
    release.assets = [];
    await updater.check();
    expect(updater.state.status).toBe('error');
    expect(updater.state.error).toContain('仍在构建');
  });
  it('校验不符、非 GitHub 地址或恶意重定向都不会进入待安装状态', async () => {
    const { updater } = await setup();
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/latest')
        ? new Response(
            JSON.stringify({
              tag_name: 'v1.3.3',
              assets: [
                {
                  name: 'DriveWorkbench-1.3.3-Windows-x64.zip',
                  browser_download_url: 'http://127.0.0.1/a',
                },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/sums' },
              ],
            }),
          )
        : new Response('0'.repeat(64) + '  DriveWorkbench-1.3.3-Windows-x64.zip'),
    );
    await updater.check();
    expect(updater.state.status).toBe('error');
    expect(updater.state.error).toContain('GitHub');
    const next = await setup();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      url.endsWith('.zip') ? new Response('wrong zip') : original(url, init),
    );
    await next.updater.check();
    expect(next.updater.state.status).toBe('error');
    expect(next.updater.state.error).toContain('SHA256');
  });
  it('Windows 更新脚本引用路径安全，等待退出、保留备份且不删除用户数据', async () => {
    const { updater, options } = await setup();
    await updater.check();
    await mkdir(path.join(options.appRoot, 'resources'), { recursive: true });
    await writeFile(path.join(options.appRoot, 'resources/app.asar'), 'old');
    const helper = await updater.prepareInstall(12345);
    expect(helper.command).toBe('powershell.exe');
    const script = Buffer.from(helper.args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("app''s folder");
    expect(script).toContain('Wait-Process -Id 12345');
    expect(script).toContain('.backup-');
    expect(script).not.toMatch(/Remove-Item|Stop-Process/);
    expect(script).toContain('resources/app.asar');
    expect(script).toContain('Move-Item -LiteralPath $backup -Destination $root');
  });
  it('Mac 更新脚本先校验签名，失败可恢复，使用独立参数传入路径', async () => {
    const { updater, options } = await setup('darwin', 'arm64');
    await updater.check();
    await mkdir(path.join(options.appRoot, 'Contents/Resources'), { recursive: true });
    await writeFile(path.join(options.appRoot, 'Contents/Resources/app.asar'), 'old');
    const helper = await updater.prepareInstall(12345);
    const script = await readFile(helper.args[0], 'utf8');
    expect(helper.command).toBe('/bin/bash');
    expect(helper.args).toContain(options.appRoot);
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).not.toContain('rm -');
  });
  it('开发目录禁用更新，安装前再次检查缓存是否被篡改', async () => {
    const { options, updater, name } = await setup();
    const dev = new PortableUpdater({ ...options, packaged: false });
    await dev.check();
    expect(dev.state.status).toBe('unsupported');
    await updater.check();
    await writeFile(path.join(options.cacheDir, name), 'tampered');
    await expect(updater.prepareInstall(123)).rejects.toThrow('已变化');
    expect(updater.state.status).toBe('error');
    await updater.check();
    expect(updater.state.status).toBe('ready');
  });
});
