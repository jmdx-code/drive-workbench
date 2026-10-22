import { describe, it, expect } from 'vitest';
import { actionProblem, selectionProblem } from '../core/access';
import { DEFAULT_SHARE, FOLDER, SHORTCUT, type FileEntry } from '../core/types';
const account = {
  id: 'a',
  permissionId: 'a',
  name: 'A',
  email: 'a@example.com',
  connections: 1,
  ready: true,
};
const file: FileEntry = {
  id: 'f',
  name: '文档',
  mimeType: 'application/pdf',
  parents: ['root'],
  ownedByMe: true,
  capabilities: {
    canEdit: true,
    canShare: true,
    canRename: true,
    canMoveItemWithinDrive: true,
    canCopy: true,
    canTrash: true,
    canUntrash: true,
    canChangeCopyRequiresWriterPermission: true,
  },
};
describe('操作前权限策略', () => {
  it('他人所有但可以分享的编辑者仍不能转让所有权', () => {
    const editor = { ...file, ownedByMe: false };
    expect(actionProblem('transfer', editor, account)).toContain('所有者');
    expect(actionProblem('share', editor, account)).toBeUndefined();
  });
  it('每种写入操作分别检查实际能力，未知不冒充有权限', () => {
    const viewer = {
      ...file,
      ownedByMe: false,
      capabilities: {
        canShare: false,
        canRename: false,
        canMoveItemWithinDrive: false,
        canCopy: false,
        canTrash: false,
        canUntrash: false,
      },
    };
    for (const kind of ['share', 'rename', 'move', 'copy', 'trash', 'restore'] as const)
      expect(actionProblem(kind, viewer, account)).toBeTruthy();
    expect(actionProblem('rename', { ...file, capabilities: {} }, account)).toContain('刷新');
  });
  it('分享权限不代表可以修改所有者专有设置或复制限制', () => {
    const editor = {
      ...file,
      ownedByMe: false,
      capabilities: { ...file.capabilities, canChangeCopyRequiresWriterPermission: false },
    };
    expect(
      actionProblem('share', editor, account, { ...DEFAULT_SHARE, writersCanShare: 'no' }),
    ).toContain('所有者');
    expect(
      actionProblem('share', editor, account, { ...DEFAULT_SHARE, copyRestriction: 'yes' }),
    ).toContain('无权');
  });
  it('混合批量选择整批阻止，不静默忽略失败文件', () => {
    expect(
      selectionProblem(
        'transfer',
        [file, { ...file, id: 'other', name: '他人文档', ownedByMe: false }],
        account,
      ),
    ).toContain('1 项不能执行：他人文档');
    expect(selectionProblem('rename', [file, { ...file, id: 'other' }], account)).toContain(
      '一个文件',
    );
  });
  it('结构限制与操作权限同时适用', () => {
    expect(actionProblem('transfer', { ...file, mimeType: SHORTCUT }, account)).toContain(
      '快捷方式',
    );
    expect(actionProblem('transfer', { ...file, driveId: 'drive' }, account)).toContain(
      '个人所有权',
    );
    expect(actionProblem('copy', { ...file, mimeType: FOLDER }, account)).toContain('文件夹');
    expect(
      actionProblem(
        'mkdir',
        { ...file, mimeType: FOLDER, capabilities: { canAddChildren: false } },
        account,
      ),
    ).toContain('无权');
  });
});
