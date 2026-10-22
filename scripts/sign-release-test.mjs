import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { signRelease } from './sign-release.mjs';
import { verifyUpdateManifest } from '../core/update-signature.ts';

const directory = await mkdtemp(path.join(tmpdir(), 'drive-signing-test-'));
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyFile = path.join(directory, 'fixture.key');
await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
for (const target of ['Windows-x64', 'macOS-arm64', 'macOS-x64'])
  await writeFile(path.join(directory, `DriveWorkbench-1.3.5-${target}.zip`), 'fixture-' + target);
const assets = await signRelease(directory, '1.3.5', keyFile, publicKey);
const raw = await readFile(path.join(directory, 'UPDATE-MANIFEST.json'), 'utf8');
const signature = await readFile(path.join(directory, 'UPDATE-MANIFEST.sig'), 'utf8');
assert.equal(verifyUpdateManifest(raw, signature, publicKey).assets.length, 3);
assert.equal(assets.length, 3);
assert.throws(() => verifyUpdateManifest(raw.replace('Windows', 'windows'), signature, publicKey));
await assert.rejects(
  signRelease(
    directory,
    '1.3.5',
    keyFile,
    generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  ),
  /不匹配/,
);
const old = process.env.WB_UPDATE_SIGNING_PRIVATE_KEY;
try {
  process.env.WB_UPDATE_SIGNING_PRIVATE_KEY = pair.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  await signRelease(directory, '1.3.5', undefined, publicKey);
} finally {
  if (old === undefined) delete process.env.WB_UPDATE_SIGNING_PRIVATE_KEY;
  else process.env.WB_UPDATE_SIGNING_PRIVATE_KEY = old;
}
console.log(
  'Signing pipeline passed: three-platform manifest, pinned key, tamper rejection, CI secret input.',
);
