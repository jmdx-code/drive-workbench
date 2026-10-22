import type { FileEntry } from './types.js';
export const permissionRoles: Record<string, string> = {
  owner: '所有者',
  writer: '编辑者',
  reader: '查看者',
  commenter: '评论者',
  organizer: '管理者',
  fileOrganizer: '内容管理者',
};
export function permissionRows(file: FileEntry, includeOwner = true) {
  if (file.permissions === undefined) return ['未提供权限明细'];
  const rows = file.permissions
    .filter((p) => !p.deleted && (includeOwner || p.role !== 'owner'))
    .map((p) => {
      const who =
        p.type === 'anyone'
          ? '任何人链接'
          : p.emailAddress ||
            p.domain ||
            p.displayName ||
            (p.type === 'group' ? '群组（邮箱未提供）' : '身份未提供');
      return `${who} · ${permissionRoles[p.role] || p.role}${p.pendingOwner ? ' · 待接收所有权' : ''}${p.permissionDetails?.some((d) => d.inherited) ? ' · 继承' : ''}${p.view === 'published' ? ' · 发布视图' : ''}`;
    });
  return rows.length
    ? rows
    : [includeOwner ? '未返回可显示授权（不代表仅本人私密）' : '未显示其他授权'];
}
export function hasExternalPermission(file: FileEntry) {
  return file.permissions?.some((p) => !p.deleted && p.role !== 'owner') ?? false;
}
export function fileLink(file: FileEntry) {
  const url = new URL(
    file.webViewLink ||
      `https://drive.google.com/${file.mimeType === 'application/vnd.google-apps.folder' ? 'drive/folders/' : 'file/d/'}${encodeURIComponent(file.id)}`,
  );
  if (file.resourceKey) url.searchParams.set('resourcekey', file.resourceKey);
  // File-provided URLs are data, never scripts or arbitrary external destinations.
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname))
    return `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
  return url.toString();
}

export function fileIcon(file: FileEntry) {
  const type = file.mimeType;
  if (type === 'application/vnd.google-apps.folder') return '📁';
  if (type === 'application/vnd.google-apps.shortcut') return '🔗';
  if (/spreadsheet|excel/.test(type)) return '📊';
  if (/presentation|powerpoint/.test(type)) return '📽️';
  if (/pdf/.test(type)) return '📕';
  if (/document|word/.test(type)) return '📝';
  if (/image/.test(type)) return '🖼️';
  if (/video/.test(type)) return '🎬';
  if (/audio/.test(type)) return '🎵';
  if (/zip|compressed|archive/.test(type)) return '🗜️';
  return '📄';
}
