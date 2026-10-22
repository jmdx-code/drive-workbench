import { describe, it, expect } from 'vitest';
import {
  directoryIndex,
  directoryPath,
  quotaSizeLabel,
  ORPHAN_NODE,
  directoryTotals,
} from '../core/directory';
import { permissionRows, hasExternalPermission, fileIcon } from '../core/presentation';
import { snapshotHtml, snapshotCsv } from '../core/snapshot';
import { FOLDER, type FileEntry } from '../core/types';
const files: FileEntry[] = [
  {
    id: 'folder',
    name: '资料',
    mimeType: FOLDER,
    parents: ['root'],
    createdTime: '2026-01-02T00:00:00Z',
  },
  {
    id: 'doc',
    name: '=危险名称<script>',
    mimeType: 'application/pdf',
    parents: ['folder'],
    size: '1024',
    quotaBytesUsed: '2048',
    createdTime: '2026-01-03T00:00:00Z',
    permissions: [
      { id: 'owner', type: 'user', role: 'owner', emailAddress: 'owner@example.com' },
      {
        id: 'reader',
        type: 'user',
        role: 'reader',
        emailAddress: 'viewer@example.com',
        permissionDetails: [{ inherited: true }],
      },
    ],
  },
  {
    id: 'orphan',
    name: '未归档',
    mimeType: 'application/pdf',
    parents: ['missing'],
    size: '0',
    quotaBytesUsed: '0',
  },
];
describe('参考1/2交互数据表达', () => {
  it('层级边界文件夹为未知，不显示为空目录或零大小', () => {
    const rows: FileEntry[] = [
      {
        id: 'boundary',
        name: '未扫描目录',
        mimeType: FOLDER,
        parents: ['root'],
        childrenScanned: false,
      },
    ];
    const d = directoryIndex(rows, 'root');
    expect(d.sizes.get('boundary')!.unknown).toBe(1);
    expect(directoryTotals(d).unknown).toBe(1);
    expect(snapshotHtml(rows, '最多1层', 'root')).toContain('下级未扫描');
    expect(snapshotCsv(rows, 'root')).not.toContain('"0","1","0","1"');
  });
  it('未包含父目录的项目独立归组，路径和汇总不丢失', () => {
    const d = directoryIndex(files, 'root');
    expect(d.parent.get('orphan')).toBe(ORPHAN_NODE);
    expect(d.parent.get('folder')).toBeUndefined();
    expect(directoryPath('doc', d)).toBe('/资料/=危险名称<script>');
    expect(d.sizes.get('folder')!.bytes).toBe(1024n);
    expect(d.sizes.get('folder')!.quotaBytes).toBe(2048n);
    expect(quotaSizeLabel(d.sizes.get('folder')!)).toBe('占用 2.0 KB');
  });
  it('显示所有邮箱角色与继承，未知或空权限不冒充私密', () => {
    expect(permissionRows(files[1])).toEqual([
      'owner@example.com · 所有者',
      'viewer@example.com · 查看者 · 继承',
    ]);
    expect(hasExternalPermission(files[1])).toBe(true);
    expect(permissionRows(files[2])).toEqual(['未提供权限明细']);
    expect(permissionRows({ ...files[2], permissions: [] })).toEqual([
      '未返回可显示授权（不代表仅本人私密）',
    ]);
  });
  it('HTML保留创建修改日期、占用、邮箱、后代数量及智能选择，并转义输入', () => {
    const html = snapshotHtml(files, '目录', 'root');
    expect(html).toContain('创建时间');
    expect(html).toContain('2026-01-03');
    expect(html).toContain('viewer@example.com');
    expect(html).toContain('占用 2.0 KB');
    expect(html).toContain('共享目录或未分类');
    expect(html).not.toContain('=危险名称<script>');
    expect(html).toContain('全选可见');
    expect(html).toContain('getClientRects');
  });
  it('CSV输出完整路径与所有权限且防止公式注入', () => {
    const csv = snapshotCsv(files, 'root');
    expect(csv).toContain('viewer@example.com');
    expect(csv).toContain('"\'=危险名称<script>"');
    expect(csv).toContain('"1024","0","2048","0"');
    expect(csv).toContain('/资料/=危险名称<script>');
  });
});

describe('统计与彩色图标', () => {
  it('汇总根目录和未分类组，不重复统计虚拟组或后代', () => {
    const totals = directoryTotals(directoryIndex(files, 'root'));
    expect(totals.files).toBe(2);
    expect(totals.folders).toBe(1);
    expect(totals.bytes).toBe(1024n);
    expect(totals.quotaBytes).toBe(2048n);
  });
  it('按文件类型提供直观图标', () => {
    expect(fileIcon(files[0])).toBe('📁');
    expect(fileIcon(files[1])).toBe('📕');
    expect(fileIcon({ ...files[1], mimeType: 'video/mp4' })).toBe('🎬');
    expect(fileIcon({ ...files[1], mimeType: 'application/vnd.google-apps.spreadsheet' })).toBe(
      '📊',
    );
  });
});
