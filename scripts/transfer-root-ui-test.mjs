import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const env = {
  ...process.env,
  WB_QA_DIR: await mkdtemp(path.join(tmpdir(), 'drive-transfer-root-')),
};
delete env.ELECTRON_RUN_AS_NODE;
const reportDir = process.argv[2]
  ? 'test-results/transfer-root-packaged'
  : 'test-results/transfer-root';
await mkdir(reportDir, { recursive: true });
const app = await electron.launch({
  ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]) } : { args: ['.'] }),
  env,
});
const errors = [],
  checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.getByRole('button', { name: '扫描', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 项目资料', exact: true }).check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  const move = page.getByRole('checkbox', {
    name: '转让后移到目标账号的“我的云端硬盘”根目录',
    exact: true,
  });
  if (await move.isChecked()) throw Error('Moving must default off');
  await move.check();
  await page
    .getByRole('checkbox', { name: '成功验证后移除原账号访问权（默认保留编辑权限）', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: '包含文件夹内后代（仍按当前所有者范围筛选）', exact: true })
    .check();
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.screenshot({ path: `${reportDir}/01-option.png` });
  const footer = await page.locator('.modal-footer').boundingBox();
  if (footer.y + footer.height > 720 || footer.y < 0) throw Error('Transfer footer not reachable');
  await page.getByRole('button', { name: '生成变更预览', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText(/移出原父目录，移至目标账号根目录/)
    .waitFor();
  if (
    !(await page
      .getByRole('dialog')
      .getByText(/保留内部层级，随所选顶层目录移动/)
      .count())
  )
    throw Error('Preview omits hierarchy preservation');
  await page.screenshot({ path: `${reportDir}/02-preview.png` });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /确认执行 \d+ 项/ })
    .click();
  const records = page.getByRole('dialog', { name: '任务记录', exact: true });
  await records.locator('.task-card').first().getByText('已完成', { exact: true }).waitFor();
  const data = await page.evaluate(async () => {
    const boot = await window.workbench.bootstrap();
    const task = await window.workbench.task(boot.tasks[0].id);
    const folder = await window.workbench.inspect('demo-work', 'projects');
    const child = await window.workbench.inspect('demo-work', 'design-a');
    const nested = await window.workbench.inspect('demo-work', 'plan');
    return { task, folder, child, nested };
  });
  if (!data.task.request.moveToTargetRoot || !data.task.request.removeSource)
    throw Error('Option lost across IPC');
  if (!data.folder.ownedByMe || data.folder.parents[0] !== 'root')
    throw Error('Folder not at target root');
  if (data.child.parents[0] !== 'projects' || data.nested.parents[0] !== 'design-a')
    throw Error('Recursive move flattened hierarchy');
  if (
    data.task.items.some(
      (i) => i.state !== 'succeeded' || i.resultFile?.permissions?.some((p) => p.id === 'demo-lin'),
    )
  )
    throw Error('Transfer cleanup incomplete');
  await records.getByRole('button', { name: '查看明细', exact: true }).first().click();
  await page.screenshot({ path: `${reportDir}/03-results.png` });
  await page.getByRole('dialog').last().getByRole('button', { name: '完成', exact: true }).click();
  await records.getByRole('button', { name: '关闭对话框', exact: true }).click();
  // Opening a fresh operation must not silently reuse the previous move preference.
  await page.getByRole('checkbox', { name: '选择 2026 品牌升级 · 项目简报', exact: true }).check();
  await page.getByRole('button', { name: '转让所有权', exact: true }).click();
  if (await move.isChecked()) throw Error('Move choice leaked into next operation');
  if (errors.length) throw Error(errors.join('\n'));
  checks.push(
    'default off and reset per operation',
    '1050x720 transfer form and footer',
    'preview lists move and hierarchy effects',
    'option preserved across IPC and task storage',
    'recursive transfer completes with source access removed',
    'nested hierarchy retained',
    'explicit execution results',
    'no console errors',
  );
  await writeFile(
    `${reportDir}/results.json`,
    JSON.stringify(
      { passed: true, checks, errors, executable: process.argv[2] || 'source build' },
      null,
      2,
    ),
  );
  console.log('Transfer-root UI passed:', checks.join('; '));
} finally {
  await app.close();
}
