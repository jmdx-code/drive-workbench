import {
  FOLDER,
  SHORTCUT,
  type Account,
  type DriveApi,
  type FileEntry,
  type Permission,
  type ScanResult,
  type ScanProgress,
} from './types.js';
export const DEMO_ACCOUNTS: Account[] = [
  {
    id: 'demo-lin',
    name: '林予安',
    email: 'yu.an.lin@example.com',
    permissionId: 'demo-lin',
    connections: 3,
    ready: true,
  },
  {
    id: 'demo-work',
    name: '工作账号',
    email: 'lin.work@example.com',
    permissionId: 'demo-work',
    connections: 2,
    ready: true,
  },
];
export function demoFiles(): FileEntry[] {
  const owner = {
    displayName: '林予安',
    emailAddress: DEMO_ACCOUNTS[0].email,
    permissionId: 'demo-lin',
  };
  const caps = {
    canEdit: true,
    canRename: true,
    canCopy: true,
    canChangeCopyRequiresWriterPermission: true,
    canShare: true,
    canTrash: true,
    canUntrash: true,
    canAddChildren: true,
    canMoveItemWithinDrive: true,
  };
  const specs: [string, string, string, string, string?][] = [
    ['brand', '品牌与设计', FOLDER, 'root'],
    ['projects', '项目资料', FOLDER, 'root'],
    ['team', '团队协作', FOLDER, 'root'],
    ['archive', '归档文件', FOLDER, 'root'],
    ['brief', '2026 品牌升级 · 项目简报', 'application/vnd.google-apps.document', 'root'],
    ['budget', '第四季度预算表', 'application/vnd.google-apps.spreadsheet', 'root'],
    ['guide', '产品设计规范 v2.0.pdf', 'application/pdf', 'root', '3824200'],
    ['presentation', '年度项目回顾', 'application/vnd.google-apps.presentation', 'root'],
    ['images', '品牌视觉素材.zip', 'application/zip', 'root', '24812000'],
    ['research', '用户访谈记录', 'application/vnd.google-apps.document', 'root'],
    ['photo', '工作室影像.jpg', 'image/jpeg', 'root', '5672000'],
    ['shortcut', '设计系统快捷方式', SHORTCUT, 'root'],
    ['design-a', '网站改版', FOLDER, 'projects'],
    ['design-b', '移动端体验研究', FOLDER, 'projects'],
    ['roadmap', '产品路线图', 'application/vnd.google-apps.spreadsheet', 'projects'],
    ['logo', '品牌标识方案.pdf', 'application/pdf', 'brand', '2351000'],
    ['font', '字体与配色指南', 'application/vnd.google-apps.document', 'brand'],
    ['plan', '网站改版执行计划', 'application/vnd.google-apps.document', 'design-a'],
    ['wireframes', '页面线框图.pdf', 'application/pdf', 'design-a', '1800000'],
    ['weekly', '团队周会记录', 'application/vnd.google-apps.document', 'team'],
    ['old', '旧版项目说明.pdf', 'application/pdf', 'archive', '120000'],
    ['trash-file', '已废弃的素材清单', 'application/vnd.google-apps.spreadsheet', 'root'],
  ];
  return specs.map(([id, name, mimeType, parent, size], index) => ({
    id,
    name,
    mimeType,
    parents: [parent],
    size,
    quotaBytesUsed: size || (mimeType === FOLDER ? '0' : String(16000 + index * 700)),
    createdTime: new Date(Date.UTC(2026, 8, 1 + index, 8, 30)).toISOString(),
    modifiedTime: new Date(Date.UTC(2026, 9, 20 - Math.floor(index / 3), 8, 30)).toISOString(),
    ownedByMe: true,
    owners: [owner],
    capabilities: caps,
    trashed: id === 'trash-file',
    writersCanShare: true,
    copyRequiresWriterPermission: false,
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    permissions: [
      {
        id: 'demo-lin',
        type: 'user',
        role: 'owner',
        emailAddress: owner.emailAddress,
        displayName: owner.displayName,
      },
      ...(index % 3 === 0
        ? [
            {
              id: `collab-${id}`,
              type: 'user' as const,
              role: 'writer' as const,
              emailAddress: 'design.team@example.com',
            },
          ]
        : []),
      ...(index % 4 === 0
        ? [{ id: `public-${id}`, type: 'anyone' as const, role: 'reader' as const }]
        : []),
    ],
  }));
}
export class DemoDrive implements DriveApi {
  files = demoFiles();
  private seq = 0;
  private async wait() {
    await new Promise((r) => setTimeout(r, 30));
  }
  private account(a: string) {
    return DEMO_ACCOUNTS.find((x) => x.id === a)!;
  }
  private view(a: string, f: FileEntry) {
    return structuredClone({ ...f, ownedByMe: f.owners?.[0]?.permissionId === a });
  }
  async get(a: string, id: string) {
    await this.wait();
    if (id === 'root')
      return {
        id: 'root',
        name: '我的云端硬盘',
        mimeType: FOLDER,
        parents: [],
        capabilities: { canAddChildren: true },
        ownedByMe: true,
      };
    const f = this.files.find((f) => f.id === id);
    if (!f) throw Object.assign(new Error('对象不存在或不可访问'), { status: 404 });
    return this.view(a, f);
  }
  async list(
    a: string,
    parent: string,
    recursive = false,
    trashed = false,
    onProgress?: (progress: ScanProgress) => void,
    maxDepth?: number,
  ): Promise<ScanResult> {
    await this.wait();
    let selected = this.files.filter((f) =>
      trashed
        ? f.trashed
        : !f.trashed &&
          (parent === 'all'
            ? true
            : parent === 'owned'
              ? f.owners?.[0]?.permissionId === a
              : parent === 'shared'
                ? f.owners?.[0]?.permissionId !== a
                : f.parents.includes(parent)),
    );
    if (
      maxDepth === undefined &&
      recursive &&
      parent !== 'all' &&
      parent !== 'owned' &&
      parent !== 'shared' &&
      !trashed
    ) {
      const out: FileEntry[] = [];
      const walk = (p: string, depth: number, path: string) => {
        for (const f of this.files.filter((f) => !f.trashed && f.parents.includes(p))) {
          out.push({ ...f, depth, path });
          if (f.mimeType === FOLDER) walk(f.id, depth + 1, `${path}/${f.name}`);
        }
      };
      walk(parent, 1, '');
      selected = out;
    }
    if (maxDepth !== undefined) {
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1000)
        throw new Error('最大扫描层级须为1到1000的整数');
      if (trashed || ['owned', 'shared'].includes(parent))
        throw new Error('层级限制仅适用于全部文件或指定目录');
      const rows: FileEntry[] = [],
        queue = [{ id: parent === 'all' ? 'root' : parent, depth: 0 }],
        seen = new Set<string>();
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i];
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        for (const f of this.files.filter((f) => !f.trashed && f.parents.includes(current.id))) {
          const depth = current.depth + 1;
          rows.push({
            ...f,
            depth,
            ...(f.mimeType === FOLDER ? { childrenScanned: recursive && depth < maxDepth } : {}),
          });
          if (recursive && f.mimeType === FOLDER && depth < maxDepth)
            queue.push({ id: f.id, depth });
        }
      }
      selected = rows;
    }
    onProgress?.({ pages: 1, items: selected.length });
    return {
      maxDepth,
      rootId: ['all', 'owned', 'shared'].includes(parent) ? 'root' : parent,
      files: selected.map((f) => this.view(a, f)),
      complete: true,
      warnings: [],
    };
  }
  async permissions(_a: string, id: string) {
    await this.wait();
    return structuredClone(this.files.find((f) => f.id === id)?.permissions || []);
  }
  async createPermission(_a: string, id: string, p: Partial<Permission>) {
    await this.wait();
    const account = DEMO_ACCOUNTS.find((a) => a.email === p.emailAddress);
    const result = { ...p, id: account?.id || `p-${++this.seq}` } as Permission;
    this.files.find((f) => f.id === id)!.permissions!.push(result);
    return structuredClone(result);
  }
  async updatePermission(
    _a: string,
    id: string,
    pid: string,
    p: Partial<Permission>,
    transfer = false,
  ) {
    await this.wait();
    const f = this.files.find((f) => f.id === id)!;
    const perm = f.permissions!.find((p) => p.id === pid)!;
    if (transfer) {
      for (const x of f.permissions!) if (x.role === 'owner') x.role = 'writer';
      const account = this.account(pid);
      f.owners = [
        { displayName: account.name, emailAddress: account.email, permissionId: account.id },
      ];
      perm.pendingOwner = false;
    }
    Object.assign(perm, p);
    return structuredClone(perm);
  }
  async deletePermission(_a: string, id: string, pid: string) {
    await this.wait();
    const f = this.files.find((f) => f.id === id)!;
    f.permissions = f.permissions!.filter((p) => p.id !== pid);
  }
  async update(
    a: string,
    id: string,
    body: Record<string, unknown>,
    q: Record<string, string> = {},
  ) {
    await this.wait();
    const f = this.files.find((f) => f.id === id)!;
    Object.assign(f, body);
    if (q.addParents) f.parents = [q.addParents];
    return this.view(a, f);
  }
  async create(a: string, body: Record<string, unknown>) {
    const account = this.account(a);
    const f: FileEntry = {
      ...body,
      name: String(body.name),
      mimeType: String(body.mimeType || 'application/octet-stream'),
      parents: (body.parents as string[]) || ['root'],
      id: `created-${++this.seq}`,
      modifiedTime: new Date().toISOString(),
      ownedByMe: true,
      owners: [{ emailAddress: account.email, permissionId: a }],
      permissions: [{ id: a, type: 'user', role: 'owner', emailAddress: account.email }],
      capabilities: {
        canEdit: true,
        canRename: true,
        canCopy: true,
        canUntrash: true,
        canMoveItemWithinDrive: true,
        canChangeCopyRequiresWriterPermission: true,
        canShare: true,
        canTrash: true,
        canAddChildren: true,
      },
    };
    this.files.push(f);
    return this.view(a, f);
  }
  async copy(a: string, id: string, body: Record<string, unknown>) {
    return this.create(a, { ...this.files.find((f) => f.id === id), ...body });
  }
  async findOperation(a: string, marker: string) {
    const f = this.files.find((f) => f.appProperties?.driveWorkbench === marker);
    return f ? this.view(a, f) : undefined;
  }
}
