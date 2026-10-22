// Sign the exact three CI-produced ZIPs, never rebuild them here.
import { createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UPDATE_PUBLIC_KEY } from '../core/update-key.ts';
import { MANIFEST_NAME, SIGNATURE_NAME, verifyUpdateManifest } from '../core/update-signature.ts';

export async function signRelease(directory, version, privateFile, publicKey = UPDATE_PUBLIC_KEY) {
  // CI uses an Environment Secret; local fallback is useful for recovery only.
  const key = createPrivateKey(
    privateFile ? await readFile(privateFile) : process.env.WB_UPDATE_SIGNING_PRIVATE_KEY || '',
  );
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !createPublicKey(key)
      .export({ type: 'spki', format: 'der' })
      .equals(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
  )
    throw Error('私钥与客户端固定公钥不匹配，拒绝签名');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('发布版本无效');
  const assets = [];
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ]) {
    const name = `DriveWorkbench-${version}-${platform === 'win32' ? 'Windows' : 'macOS'}-${arch}.zip`;
    const file = path.join(directory, name),
      before = await stat(file);
    if (!before.isFile() || before.size < 1 || before.size > 1024 ** 3)
      throw Error('更新包大小无效');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw Error('签名期间更新包发生变化');
    assets.push({ name, platform, arch, size: before.size, sha256: hash.digest('hex') });
  }
  if ((await readdir(directory)).filter((name) => name.endsWith('.zip')).length !== 3)
    throw Error('签名目录必须只含当前版本的三个平台 ZIP');
  const raw = JSON.stringify({ schema: 1, version, assets }, null, 2) + '\n';
  const signature = sign(null, Buffer.from(raw), key).toString('hex');
  verifyUpdateManifest(raw, signature, publicKey);
  await writeFile(path.join(directory, MANIFEST_NAME), raw);
  await writeFile(path.join(directory, SIGNATURE_NAME), signature + '\n');
  // Preserve the legacy checksum asset for the one-time old-client transition.
  await writeFile(
    path.join(directory, 'SHA256SUMS.txt'),
    assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(''),
  );
  return assets;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const assets = await signRelease(
    path.resolve(process.argv[2] || path.join(root, 'release')),
    pkg.version,
    process.env.WB_UPDATE_SIGNING_PRIVATE_KEY
      ? undefined
      : process.env.WB_UPDATE_SIGNING_KEY_FILE ||
          path.join(homedir(), '.drive-workbench-signing/update-ed25519-private.pem'),
  );
  console.log(
    `Signed ${assets.length} packages for ${pkg.version}. Private key contents were not printed.`,
  );
}
