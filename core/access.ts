import {
  FOLDER,
  SHORTCUT,
  type Account,
  type ActionRequest,
  type FileEntry,
  type ShareConfig,
} from './types.js';
import { ownershipOf } from './permissions.js';

// Google capabilities describe the current account, not just the file owner's role.
export function actionProblem(
  kind: ActionRequest['kind'],
  file: FileEntry,
  account?: Account,
  share?: ShareConfig,
): string | undefined {
  const capability = (key: string, message: string) =>
    file.capabilities?.[key] === true
      ? undefined
      : file.capabilities?.[key] === false
        ? message
        : '操作权限信息不完整，请先刷新操作权限';
  if (file.trashed && kind !== 'restore') return '文件位于回收站，请先恢复';
  if (kind === 'mkdir')
    return file.mimeType !== FOLDER
      ? '目标不是文件夹'
      : capability('canAddChildren', '无权在此目录新建文件夹');
  if (file.id === 'root' || (file.mimeType === FOLDER && !file.parents.length))
    return '根目录不能执行此操作';
  if (kind === 'transfer') {
    if (file.driveId) return '共享云端硬盘没有个人所有权';
    if (file.mimeType === SHORTCUT) return '请选择实际文件，快捷方式暂不转让';
    if (ownershipOf(file, account) !== 'mine') return '只有文件所有者才能转让所有权';
    return capability('canShare', '无权发起所有权转让');
  }
  if (kind === 'share') {
    const managePeople =
      !share ||
      share.public !== 'keep' ||
      share.collaborators !== 'keep' ||
      share.removeGroups ||
      share.removeDomains;
    const sharing = managePeople ? capability('canShare', '当前账号无权管理共享权限') : undefined;
    if (sharing) return sharing;
    if (share && share.writersCanShare !== 'keep') {
      if (file.driveId) return '共享云端硬盘不支持编辑者再次分享开关';
      if (ownershipOf(file, account) !== 'mine') return '只有所有者才能设置编辑者再次分享';
      const edit = capability('canEdit', '无权修改分享设置');
      if (edit) return edit;
    }
    if (share && share.copyRestriction !== 'keep')
      return capability(
        'canChangeCopyRequiresWriterPermission',
        '无权修改查看者复制、下载与打印限制',
      );
    return;
  }
  if (kind === 'copy' && file.mimeType === FOLDER) return '文件夹不能直接创建副本，请选择文件';
  const capabilities = {
    rename: ['canRename', '无权重命名此文件'],
    move: ['canMoveItemWithinDrive', '无权移动此文件'],
    copy: ['canCopy', '无权创建此文件的副本'],
    trash: ['canTrash', '无权将此文件移入回收站'],
    restore: ['canUntrash', '无权恢复此文件'],
  } as const;
  const [key, message] = capabilities[kind];
  return capability(key, message);
}

export function selectionProblem(
  kind: ActionRequest['kind'],
  files: FileEntry[],
  account?: Account,
  share?: ShareConfig,
) {
  if (!files.length) return '请先选择文件';
  if (kind === 'rename' && files.length !== 1) return '重命名一次只能选择一个文件';
  const blocked = files
    .map((file) => ({ file, problem: actionProblem(kind, file, account, share) }))
    .filter((item) => item.problem);
  if (blocked.length)
    return `${blocked.length} 项不能执行：${blocked[0].file.name} — ${blocked[0].problem}`;
}
