import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { rcedit } from 'rcedit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets/branding/app-icon-source.png');
const ico = path.join(root, 'assets/branding/app-icon.ico');

export async function prepareIcons() {
  await sharp(source).resize(512, 512).png().toFile(path.join(root, 'public/app-icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(
    sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
  );
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const p = 6 + i * 16;
    header[p] = header[p + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(images[i].length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += images[i].length;
  });
  await writeFile(ico, Buffer.concat([header, ...images]));
  const macImages = await Promise.all(
    [256, 512, 1024].map((size) => sharp(source).resize(size, size).png().toBuffer()),
  );
  const chunks = macImages.map((data, i) => {
    const header = Buffer.alloc(8);
    header.write(['ic08', 'ic09', 'ic10'][i]);
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const macHeader = Buffer.alloc(8);
  macHeader.write('icns');
  macHeader.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
  await writeFile(
    path.join(root, 'assets/branding/app-icon.icns'),
    Buffer.concat([macHeader, ...chunks]),
  );
}

export async function brandExecutable(executable) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await rcedit(executable, {
    icon: ico,
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      ProductName: '云盘工作台',
      FileDescription: '云盘工作台',
      CompanyName: 'Drive Workbench',
      OriginalFilename: '云盘工作台.exe',
      InternalName: 'DriveWorkbench',
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareIcons();
  console.log('Prepared PNG and multi-resolution Windows ICO.');
}
