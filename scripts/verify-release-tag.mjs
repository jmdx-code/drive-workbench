import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (
  process.env.BUILD_ONLY !== 'true' &&
  (!/^v\d+\.\d+\.\d+$/.test(process.env.RELEASE_TAG || '') ||
    process.env.RELEASE_TAG !== `v${pkg.version}`)
)
  throw Error('Release tag must exactly match package.json version');
console.log('Release version verified:', pkg.version);
