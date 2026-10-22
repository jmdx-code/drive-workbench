# 云盘工作台 UI 视觉升级

## 紧凑布局与筛选统计补充（2026-10-20）

统计区已移入最上方标题区，取消独立统计行；压缩主工作区外边距、扫描/筛选栏和面包屑上下留白。文件与文件夹在相同目录层级使用同一图标起点，复选框去除默认外边距以避免溢出省略点；Excel MIME 和通用 MIME 的常见扩展名识别统一在 `src/fileVisual.ts`，图片与视频分别使用不同色调。

顶部统计与列表共用筛选条件，响应搜索、所有者、类型与当前目录。统计包含折叠后代和未进入虚拟渲染区域的匹配项目；展开/收起不改变统计。大小与占用只累加匹配文件，避免重复累计目录汇总；只筛选文件夹时显示文件夹数量，文件大小合计为 0 B。未知大小与未扫描边界继续保留。扫描时间不随筛选变化，筛选不发起新的 API 请求，导出仍使用完整本次扫描目录。

补充验收：`node scripts/compact-filter-ui-test.mjs`，报告与截图在 `test-results/compact/`。覆盖筛选交集、无结果、未知大小、目录切换、无重复累计、图标识别与对齐、紧凑布局以及额外请求计数。此次改动前的界面备份为 `backups/ui-compact-20261020-203856/src/`；恢复其中的 `App.tsx` 与 `layout.css` 并执行 `npm run build:local` 即可回到上一版视觉，新增 `fileVisual.ts` 留存不影响旧版入口。

实施日期：2026-10-20。风格采用浅灰画布、白色工作区、石墨文字和松绿主色，保持原有三栏工作台与全部操作入口。

## 修改范围

- `src/tokens.css`：集中定义颜色、间距、控件高度、圆角、阴影和动效变量。
- `src/styles.css`：统一按钮、输入框、状态标签、弹窗、表单、变更预览、授权连接、任务卡片、菜单和提示消息。
- `src/layout.css`：集中管理账号栏、工作区、扫描统计与筛选工具、表格、列分隔、操作控制台和窗口断点；移除旧的多轮重复覆盖。
- `src/App.tsx`：增加品牌区、工作区标题、无选择提示、操作分组，使用项目已有 Lucide 图标库绘制彩色文件图标；操作区内部滚动，标题与任务入口保持可达。
- `src/main.tsx`：在组件和布局样式前加载设计变量。

未修改 `core/`、`desktop/`、API、数据库结构、权限规则和业务状态。未新增运行时依赖。文件类型图标只影响应用内呈现，独立 HTML 导出的原有图标与交互保留。

目录名称保留 16px，辅助数据按层级使用 11–13px；权限明细仍限定 40px 并可内部滚动。表格六个数据列保留，窄窗口通过表格内部横向滚动查看。文件选择、树展开、列宽保存和扫描边界维持原有语义。

## 验证与复现

构建：`npm run build`。本地运行文件更新：`node scripts/build-local.mjs`，或使用已有的 `npm run build:local`。

执行下列验收：

```text
npm test
npm run test:ui
npm run test:table
npm run test:permissions
npm run test:context
npm run test:depth
npm run test:access
npm run test:references
node scripts/ui-design-test.mjs
```

58 项单元测试，以及上述 UI 套件均使用隔离演示账号或模拟请求。覆盖扫描、搜索与筛选、零额外 Drive 读取、权限表单与预览执行、所有权转让、创建/重命名/移动/回收/恢复、复制链接、导出、框选、权限能力校验和列宽持久化。

新增 `scripts/ui-design-test.mjs` 验证 1050×720、1100×760、1440×960、1920×1080，检查工作区和工具栏越界、目录可用高度、数据列保留、弹窗和底部按钮边界、设置提交与回显、演示链接导入、键盘焦点及控制台错误。截图及结果位于 `test-results/design/`，其他套件报告位于 `test-results/*-results.json`。

适配与实测以当前桌面产品支持的最小窗口 1050×720 为边界；未将桌面业务改造成独立手机产品。测试没有访问或修改真实 Google Drive；真实网络、授权及外部账号状态不在视觉验收的保证范围内。

原有测试的两处呈现假设已同步更新：彩色图标检查改为检查 SVG 图标；框选脚本先将数据单元格移到固定表头下方并验证命中目标，避免从被遮挡的单元格坐标开始拖动。

## 回滚

原项目没有 Git 仓库，已建立完整源界面备份：`backups/ui-upgrade-20261020-201724/src/`；原测试脚本在同目录 `scripts/`，旧截图和结果在 `test-results/`，原本地运行包的编译内容在 `local-app/`。

关闭云盘工作台后，在项目根目录运行：

```powershell
$uiBackup = 'backups/ui-upgrade-20261020-201724'
foreach ($name in @('App.tsx', 'main.tsx', 'styles.css', 'layout.css')) {
  Copy-Item -LiteralPath (Join-Path $uiBackup ('src/' + $name)) -Destination (Join-Path 'src' $name) -Force
}
foreach ($name in @('tree-context-ui-test.mjs', 'reference-ui-test.mjs')) {
  Copy-Item -LiteralPath (Join-Path $uiBackup ('scripts/' + $name)) -Destination (Join-Path 'scripts' $name) -Force
}
npm run build:local
```

恢复后的入口不会再加载新增的 `tokens.css`；该文件与新增的设计验收脚本可保留，不影响旧界面运行。重新启动 `本地测试/云盘工作台.exe` 查看恢复结果。
