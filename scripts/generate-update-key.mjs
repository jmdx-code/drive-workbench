import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicFile = path.join(root, 'core/update-key.ts');
if (!/UPDATE_PUBLIC_KEY = ''/.test(await readFile(publicFile, 'utf8')))
  throw Error('已有公钥，拒绝自动轮换；请先制定密钥轮换方案');
const directory = path.join(homedir(), '.drive-workbench-signing');
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.platform === 'win32') {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = `$p=${quote(directory)}; $ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)`;
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'pipe' },
  );
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privateFile = path.join(directory, 'update-ed25519-private.pem');
await writeFile(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  publicFile,
  '// Public trust anchor. The private key is kept outside the repository.\nexport const UPDATE_PUBLIC_KEY = ' +
    JSON.stringify(publicKey.export({ type: 'spki', format: 'pem' })) +
    ';\n',
);
console.log('Public key pinned. Private key created outside repository: ' + privateFile);
