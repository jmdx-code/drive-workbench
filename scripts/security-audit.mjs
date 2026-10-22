// Read-only evidence collection. Output never includes matched credential values.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/security');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const entries = Object.entries(lock.packages).filter(([location]) => location);
const inventory = entries.map(([location, value]) => ({
  location,
  name: location.split('node_modules/').at(-1),
  version: value.version,
  direct:
    Object.hasOwn(manifest.dependencies || {}, location.slice(13)) ||
    Object.hasOwn(manifest.devDependencies || {}, location.slice(13)),
  dev: !!value.dev,
  optional: !!value.optional,
  integrity: value.integrity,
  resolved: value.resolved,
  ...(value.deprecated ? { deprecated: value.deprecated } : {}),
}));
await writeFile(path.join(output, 'dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
const maintenanceNames = [
  ...new Set([
    ...inventory.filter((entry) => entry.direct).map((entry) => entry.name),
    'postject',
    'progress',
    'retry',
    'sumchecker',
    'cross-spawn-windows-exe',
  ]),
];
const maintenance = [];
for (let start = 0; start < maintenanceNames.length; start += 6) {
  await Promise.all(
    maintenanceNames.slice(start, start + 6).map(async (name) => {
      try {
        const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error(`npm registry HTTP ${response.status}`);
        const data = await response.json(),
          latest = data['dist-tags']?.latest;
        const installed = inventory
          .filter((entry) => entry.name === name)
          .map((entry) => entry.version);
        maintenance.push({
          name,
          latest,
          latestPublished: data.time?.[latest],
          repository: data.repository,
          installed: installed.map((version) => ({
            version,
            published: data.time?.[version],
            deprecated: data.versions?.[version]?.deprecated,
          })),
        });
      } catch (error) {
        maintenance.push({ name, error: String(error) });
      }
    }),
  );
}
await writeFile(path.join(output, 'maintenance.json'), JSON.stringify(maintenance, null, 2) + '\n');
const osv = [];
for (let start = 0; start < inventory.length; start += 50) {
  const batch = inventory.slice(start, start + 50);
  try {
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: batch.map(({ name, version }) => ({
          package: { name, ecosystem: 'npm' },
          version,
        })),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error(`OSV HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.results) || data.results.length !== batch.length)
      throw Error('OSV returned incomplete results');
    batch.forEach((entry, i) =>
      osv.push({
        name: entry.name,
        version: entry.version,
        location: entry.location,
        result: data.results[i],
      }),
    );
  } catch (error) {
    batch.forEach(({ name, version, location }) =>
      osv.push({
        name,
        version,
        location,
        error: String(error),
      }),
    );
  }
}
await writeFile(
  path.join(output, 'osv.json'),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      results: osv,
    },
    null,
    2,
  ) + '\n',
);

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google-oauth-secret', /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/g],
  ['google-access-token', /\bya29\.[0-9A-Za-z_.-]{20,}/g],
  ['google-refresh-token', /\b1\/\/[0-9A-Za-z_-]{30,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['aws-access-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  [
    'webhook',
    /https:\/\/(?:hooks\.slack\.com\/services|(?:discord(?:app)?\.com)\/api\/webhooks)\/[^\s"'<>]+/g,
  ],
  [
    'connection-string',
    /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]*:[^\s"'<>]*@[^\s"'<>]+/g,
  ],
];
function matches(content, file) {
  const hits = [];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern))
      hits.push({
        file,
        kind,
        line: content.slice(0, match.index).split('\n').length,
      });
  }
  return hits;
}
const findings = [],
  files = [],
  sensitiveNames = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules'].includes(entry.name)) await walk(file);
    } else if (entry.isFile()) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (relative.startsWith('docs/security/')) continue;
      const bytes = await readFile(file);
      files.push({ file: relative, bytes: bytes.length });
      if (
        /^(?:\.env(?:\..*)?|credentials.*\.json|token(?:-.*)?\.json)$|\.(?:pem|p12|pfx|key|sqlite\w*|db)$/i.test(
          entry.name,
        )
      )
        sensitiveNames.push(relative);
      findings.push(...matches(bytes.toString('utf8'), relative));
    }
  }
}
await walk(root);
const git = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // child_process errors may embed stdout containing sensitive material.
    throw Error(`Git evidence collection failed (${args[0]}); no content printed`);
  }
};
// Inspect all reachable historical blob contents as well as the working tree.
const objects = git('rev-list', '--objects', '--all').trim().split('\n');
const historyFindings = [];
let blobs = 0;
for (const object of objects) {
  const [id, ...parts] = object.split(' ');
  if (git('cat-file', '-t', id).trim() !== 'blob') continue;
  blobs++;
  historyFindings.push(
    ...matches(git('cat-file', 'blob', id), parts.join(' ')).map((hit) => ({ ...hit, blob: id })),
  );
}
await writeFile(
  path.join(output, 'secret-scan.json'),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      exclusions: [
        '.git (scanned through Git objects)',
        'node_modules',
        'docs/security (generated evidence)',
        'symlinks',
      ],
      files,
      sensitiveNames,
      findings,
      historicalBlobs: blobs,
      historyFindings,
      trackedSensitiveNames: git('ls-files', '-z')
        .split('\0')
        .filter((file) =>
          /(?:^|\/)(?:\.env(?:\..*)?|credentials.*\.json|token(?:-.*)?\.json)$|\.(?:pem|p12|pfx|key|sqlite\w*|db)$/i.test(
            file,
          ),
        ),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    dependencies: inventory.length,
    osvFindings: osv.filter((item) => item.result?.vulns?.length).length,
    osvErrors: osv.filter((item) => item.error).length,
    files: files.length,
    credentialPatternMatches: findings.length,
    historicalBlobs: blobs,
    historicalPatternMatches: historyFindings.length,
  }),
);
