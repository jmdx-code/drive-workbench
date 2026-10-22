import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-compact-')) };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir('test-results/compact', { recursive: true });
const app = await electron.launch({ args: ['.'], env });
const errors = [],
  checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByRole('button', { name: '扫描', exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => {
    globalThis.compactReads = 0;
    const original = ipcMain._invokeHandlers.get('workbench:list');
    ipcMain.removeHandler('workbench:list');
    ipcMain.handle('workbench:list', async (...args) => {
      const result = await original(...args);
      globalThis.compactReads++;
      const file = (id, name, mimeType, size, parents = ['root'], ownedByMe = true) => ({
        id,
        name,
        mimeType,
        size,
        quotaBytesUsed: size,
        parents,
        ownedByMe,
        permissions: [],
      });
      result.files = [
        file('compact-folder', 'Alpha folder', 'application/vnd.google-apps.folder', undefined),
        file('compact-root', 'Alpha.pdf', 'application/pdf', '100'),
        file(
          'compact-child',
          'Beta.xlsx',
          'application/vnd.ms-excel',
          '200',
          ['compact-folder'],
          false,
        ),
        file('compact-video', 'Clip.mp4', 'application/octet-stream', '300', ['compact-folder']),
        file('compact-unknown', 'Unknown.jpg', 'image/jpeg', undefined),
      ];
      return result;
    });
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  const summary = page.locator('.workspace-header .scan-summary');
  const expectStats = async (text, size) => {
    await page.waitForFunction(
      ({ text, size }) => {
        const s = document.querySelector('.scan-summary')?.textContent;
        return s?.includes(text) && s.includes(size);
      },
      { text, size },
    );
  };
  await expectStats('4 个文件 · 1 个文件夹', '600 B');
  const scanTime = await summary.locator('div').nth(1).innerText();
  await page.getByRole('button', { name: '展开 Alpha folder', exact: true }).click();
  await expectStats('4 个文件 · 1 个文件夹', '600 B');
  const search = page.getByRole('textbox', { name: '搜索文件', exact: true });
  await search.fill('Alpha');
  await expectStats('1 个文件 · 1 个文件夹', '100 B');
  await search.fill('no matches');
  await expectStats('0 个文件 · 0 个文件夹', '0 B');
  await search.fill('');
  await page.getByRole('combobox', { name: '所有者筛选', exact: true }).selectOption('others');
  await expectStats('1 个文件 · 0 个文件夹', '200 B');
  await page.getByRole('combobox', { name: '所有者筛选', exact: true }).selectOption('all');
  await page.getByRole('combobox', { name: '文件类型筛选', exact: true }).selectOption('folder');
  await expectStats('0 个文件 · 1 个文件夹', '0 B');
  await page.getByRole('combobox', { name: '文件类型筛选', exact: true }).selectOption('all');
  await expectStats('4 个文件 · 1 个文件夹', '600 B');
  if ((await summary.locator('div').nth(1).innerText()) !== scanTime)
    throw Error('Filtering changed scan time');
  if (!(await summary.innerText()).includes('1 项未知')) throw Error('Unknown size became zero');
  for (const [id, tone] of [
    ['compact-folder', 'folder'],
    ['compact-root', 'pdf'],
    ['compact-child', 'sheet'],
    ['compact-video', 'video'],
  ]) {
    if (!(await page.locator(`tr[data-file-id="${id}"] .file-icon.${tone} svg`).count()))
      throw Error('Incorrect icon ' + id);
  }
  const folderIcon = await page
    .locator('tr[data-file-id="compact-folder"] .file-icon')
    .boundingBox();
  const fileIcon = await page.locator('tr[data-file-id="compact-root"] .file-icon').boundingBox();
  if (Math.abs(folderIcon.x - fileIcon.x) > 1) throw Error('Root file/folder icons misaligned');
  await page
    .locator('tr[data-file-id="compact-folder"]')
    .getByRole('button', { name: 'Alpha folder 更多操作', exact: true })
    .click();
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expectStats('2 个文件 · 0 个文件夹', '500 B');
  await page.locator('.local-crumbs button').first().click();
  await expectStats('4 个文件 · 1 个文件夹', '600 B');
  checks.push(
    'filter totals: search, no match, ownership, type; unknown sizes preserved; no folder double count; expansion stable; MIME and extension icons; root icon alignment',
  );
  for (const [width, height] of [
    [1050, 720],
    [1440, 960],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.workspace-header').getBoundingClientRect();
      const summary = document.querySelector('.scan-summary').getBoundingClientRect();
      const location = document.querySelector('.directory-location').getBoundingClientRect();
      const check = document.querySelector('tr[data-file-id] .check-cell');
      return {
        inHeader: summary.top >= header.top && summary.bottom <= header.bottom,
        locationHeight: location.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        checkboxFits: check.scrollWidth <= check.clientWidth,
      };
    });
    if (!layout.inHeader || layout.locationHeight > 32 || layout.overflow || !layout.checkboxFits)
      throw Error(JSON.stringify(layout));
    await page.screenshot({ path: `test-results/compact/workspace-${width}.png` });
  }
  if ((await app.evaluate(() => globalThis.compactReads)) !== 1)
    throw Error('Filtering caused extra Drive reads');
  if (errors.length) throw Error(errors.join('\n'));
  checks.push(
    'statistics inside title header; compact breadcrumb; checkbox cell without clipping; 1050/1440/1920 layouts; zero additional reads; no console errors',
  );
  await writeFile(
    'test-results/compact/results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Compact/filter UI passed:', checks.join('; '));
} finally {
  await app.close();
}
