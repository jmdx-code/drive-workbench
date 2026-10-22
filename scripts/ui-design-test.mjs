// Presentation acceptance against an isolated demo profile; never opens live accounts.
import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const env = { ...process.env, WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-design-')) };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir('test-results/design', { recursive: true });
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
  const screenshot = (name) => page.screenshot({ path: `test-results/design/${name}.png` });
  const close = () =>
    page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: '关闭对话框', exact: true })
      .click();
  const bounds = async () => {
    const problems = await page.evaluate(() => {
      const issues = [];
      if (document.documentElement.scrollWidth > innerWidth) issues.push('document overflow');
      for (const selector of [
        '.directory-workspace',
        '.scan-toolbar',
        '.file-toolbar',
        '.modal',
        '.modal-footer',
      ]) {
        for (const el of document.querySelectorAll(selector)) {
          const b = el.getBoundingClientRect();
          if (b.left < -1 || b.right > innerWidth + 1 || b.top < -1 || b.bottom > innerHeight + 1)
            issues.push(`${selector} outside viewport`);
          if (el.scrollWidth > el.clientWidth + 2) issues.push(`${selector} content clipped`);
        }
      }
      const list = document.querySelector('.table-scroll');
      if (list && list.clientHeight < 180) issues.push('insufficient list height');
      return issues;
    });
    if (problems.length) throw Error(problems.join('; '));
  };
  await page.setViewportSize({ width: 1440, height: 960 });
  await screenshot('01-empty');
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.locator('.scan-summary').waitFor();
  if (await page.locator('.toast .icon-button').count())
    await page.locator('.toast .icon-button').click();
  for (const [width, height] of [
    [1050, 720],
    [1100, 760],
    [1440, 960],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const b = document.querySelector('.compact-shell').getBoundingClientRect();
      return Math.abs(b.width - innerWidth) < 1 && Math.abs(b.height - innerHeight) < 1;
    });
    await bounds();
    if ((await page.locator('th[data-column]').count()) !== 6) throw Error('Missing data columns');
    for (const th of await page.locator('th[data-column]').all())
      if (await th.evaluate((el) => getComputedStyle(el).display === 'none'))
        throw Error('Hidden data column');
    await screenshot(`02-workspace-${width}`);
    checks.push(
      `workspace ${width}x${height}: no clipping, usable list, all six data columns retained`,
    );
  }
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '并发与执行设置', exact: true });
  await settings.getByRole('spinbutton', { name: '每账号并发上限', exact: true }).fill('8');
  await bounds();
  await screenshot('03-settings-1050');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('执行设置已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  if (
    (await settings
      .getByRole('spinbutton', { name: '每账号并发上限', exact: true })
      .inputValue()) !== '8'
  )
    throw Error('Settings submission lost value');
  await close();
  checks.push('settings save and reopen preserves submitted value');
  await page.getByRole('button', { name: '账号与授权', exact: true }).click();
  await bounds();
  await screenshot('04-connections-1050');
  await close();
  await page.getByText('更多文件操作', { exact: true }).click();
  await page.getByRole('button', { name: '导入文件链接', exact: true }).click();
  await bounds();
  if (!(await page.getByRole('button', { name: '验证并导入', exact: true }).isDisabled()))
    throw Error('Empty import is enabled');
  await page
    .getByRole('textbox', { name: '文件链接列表', exact: true })
    .fill('https://docs.google.com/document/d/brief/edit');
  await page.getByRole('button', { name: '验证并导入', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('link import empty state and demo submission');
  await page.getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true }).check();
  await page.getByRole('button', { name: '修改邮箱角色', exact: true }).click();
  await page
    .getByRole('textbox', { name: '协作者列表', exact: true })
    .fill('one@example.com\ntwo@example.com');
  await bounds();
  await screenshot('05-permission-1050');
  await page.getByRole('button', { name: '生成变更预览', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    return el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none';
  });
  if (!focus) throw Error('Keyboard focus is not visible');
  await close();
  await page.setViewportSize({ width: 1440, height: 960 });
  await screenshot('06-selected');
  await page.getByRole('button', { name: '任务记录', exact: true }).click();
  await bounds();
  await screenshot('07-tasks-empty');
  await close();
  checks.push(
    'authorization, import, permission, tasks dialogs fit minimum window; visible keyboard focus',
  );
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(
    'test-results/design/results.json',
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log('Design UI passed:', checks.join('; '));
} finally {
  await app.close();
}
