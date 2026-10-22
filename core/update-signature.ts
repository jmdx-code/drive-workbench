import { createPublicKey, verify } from 'node:crypto';

export const MANIFEST_NAME = 'UPDATE-MANIFEST.json';
export const SIGNATURE_NAME = 'UPDATE-MANIFEST.sig';
export interface UpdateAsset {
  name: string;
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
  size: number;
  sha256: string;
}
export interface UpdateManifest {
  schema: 1;
  version: string;
  assets: UpdateAsset[];
}

export function verifyUpdateManifest(
  raw: string,
  signature: string,
  publicKey: string,
): UpdateManifest {
  if (!publicKey) throw Error('更新签名公钥尚未配置');
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !/^[a-f0-9]{128}$/i.test(signature.trim()) ||
    !verify(null, Buffer.from(raw, 'utf8'), key, Buffer.from(signature.trim(), 'hex'))
  )
    throw Error('更新清单签名无效，未下载或安装');
  const manifest = JSON.parse(raw) as UpdateManifest;
  if (
    !manifest ||
    manifest.schema !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !Array.isArray(manifest.assets) ||
    !manifest.assets.length ||
    manifest.assets.length > 4
  )
    throw Error('已签名更新清单格式无效');
  const names = new Set<string>();
  for (const asset of manifest.assets) {
    if (
      !asset ||
      !['win32', 'darwin'].includes(asset.platform) ||
      !['x64', 'arm64'].includes(asset.arch) ||
      asset.name !==
        `DriveWorkbench-${manifest.version}-${asset.platform === 'win32' ? 'Windows' : 'macOS'}-${asset.arch}.zip` ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > 1024 ** 3 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      names.has(asset.name)
    )
      throw Error('已签名更新包信息无效或重复');
    names.add(asset.name);
  }
  return manifest;
}
