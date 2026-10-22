import { cp, mkdir, readFile, writeFile, access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandExecutable } from './branding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '本地测试');
const executable = path.join(output, '云盘工作台.exe');
const appRoot = path.join(output, 'resources', 'app');
await mkdir(output, { recursive: true });
try {
  await access(executable);
} catch {
  await cp(path.join(root, 'node_modules', 'electron', 'dist'), output, { recursive: true });
  await rename(path.join(output, 'electron.exe'), executable);
}
await mkdir(appRoot, { recursive: true });
for (const name of ['dist', 'dist-desktop']) {
  const target = path.resolve(appRoot, name);
  if (path.dirname(target) !== appRoot) throw new Error('编译目标超出本地测试目录');
  await rm(target, { recursive: true, force: true });
  await cp(path.join(root, name), target, { recursive: true });
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await brandExecutable(executable);
await writeFile(
  path.join(appRoot, 'package.json'),
  JSON.stringify({
    name: pkg.name,
    productName: '云盘工作台',
    version: pkg.version,
    type: 'module',
    main: pkg.main,
  }),
);
await writeFile(
  path.join(output, '测试说明.txt'),
  '双击 云盘工作台.exe 启动。后续编译直接更新本目录，不需要解压或安装。\r\n本目录包含运行所需文件，请保留整个目录。更新后重新启动应用查看修改。\r\n',
);
console.log(`本地测试程序：${executable}\n未生成压缩包。`);
