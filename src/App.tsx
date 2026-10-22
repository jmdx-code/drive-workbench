import { actionProblem, selectionProblem } from '../core/access';
import { matchesOwner, ownershipOf } from '../core/permissions';
import { useColumnResize, TABLE_FIXED_WIDTH, type ColumnKey } from './useColumnResize';
import { fileVisual } from './fileVisual';
import {
  directoryIndex,
  directoryTotals,
  directorySizeLabel,
  quotaSizeLabel,
  directoryPath,
  ORPHAN_NODE,
} from '../core/directory';
import { permissionRows, hasExternalPermission, fileLink } from '../core/presentation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FileSpreadsheet,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  Presentation,
  Folder,
  FolderPlus,
  KeyRound,
  Link,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  MoveRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  X,
  AlertCircle,
  RotateCcw,
  Zap,
} from 'lucide-react';
import { useMarquee } from './useMarquee';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SHARE,
  FOLDER,
  SHORTCUT,
  TITLES,
  type Account,
  type ActionRequest,
  type Bootstrap,
  type Collaborator,
  type FileEntry,
  type Permission,
  type Plan,
  type ShareConfig,
  type Task,
} from '../core/types';

const api = window.workbench;
const collator = new Intl.Collator('zh-CN', { numeric: true });
const roles: Record<string, string> = {
  reader: '查看者',
  commenter: '评论者',
  writer: '编辑者',
  owner: '所有者',
  organizer: '管理者',
  fileOrganizer: '内容管理者',
};
const states: Record<string, string> = {
  queued: '等待中',
  running: '处理中',
  succeeded: '已验证',
  skipped: '已跳过',
  failed: '失败',
  unknown: '待对账',
  cancelled: '已取消',
  waiting_auth: '等待授权',
  completed: '已完成',
  partial: '部分完成',
  paused: '已暂停',
};
const folderNames: Record<string, string> = {
  root: '我的云端硬盘',
  owned: '本人拥有',
  shared: '与我共享',
  trash: '回收站',
};
function IconFile({ file, size = 24 }: { file: FileEntry; size?: number }) {
  const tone = fileVisual(file);
  const Icon = {
    folder: Folder,
    shortcut: Link,
    sheet: FileSpreadsheet,
    slides: Presentation,
    pdf: FileText,
    image: FileImage,
    video: FileVideo,
    audio: FileAudio,
    archive: FileArchive,
    doc: FileText,
  }[tone];
  return (
    <span
      className={`file-icon color-file-icon ${tone}`}
      role="img"
      aria-label={file.mimeType === FOLDER ? '文件夹图标' : '文件类型图标'}
      style={{ fontSize: size }}
    >
      <Icon size={size - 4} strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}
const typeLabel = (f: FileEntry) =>
  f.mimeType === FOLDER
    ? '文件夹'
    : f.mimeType === SHORTCUT
      ? '快捷方式'
      : f.mimeType.includes('spreadsheet')
        ? 'Google 表格'
        : f.mimeType.includes('document')
          ? 'Google 文档'
          : f.mimeType.includes('presentation')
            ? '演示文稿'
            : f.mimeType.includes('pdf')
              ? 'PDF 文档'
              : f.mimeType.includes('image')
                ? '图片'
                : '文件';
const dateLabel = (s?: string) =>
  s ? new Date(s).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : '—';
function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function AccountAvatar({ account }: { account: Account }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [account.avatar]);
  return (
    <span className="account-initial">
      {account.avatar && !failed ? (
        <img src={account.avatar} alt={`${account.email} 的头像`} onError={() => setFailed(true)} />
      ) : (
        (account.name || account.email).slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  danger = false,
  disabled = false,
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      className={`button ${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <span className="modal-heading-icon">
            <FileText size={21} />
          </span>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭对话框" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function parseId(raw: string) {
  const s = raw.trim();
  if (/^[\w-]{10,}$/.test(s) || s === 'root') return s;
  try {
    const u = new URL(s);
    if (!['drive.google.com', 'docs.google.com'].includes(u.hostname)) return '';
    return u.pathname.match(/\/(?:d|folders)\/([\w-]+)/)?.[1] || u.searchParams.get('id') || '';
  } catch {
    return '';
  }
}
function parsePeople(text: string, type: Collaborator['type'], role: Collaborator['role']) {
  return [
    ...new Set(
      text
        .split(/[\s,;，；]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].map((email) => ({ email, type, role }));
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>({
    mode: 'live',
    demoEnabled: false,
    accounts: [],
    connections: [],
    tasks: [],
    settings: DEFAULT_SETTINGS,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    widths: columnWidths,
    bindings: columnBindings,
    reset: resetColumns,
  } = useColumnResize(scrollRef);
  const columnHandle = (key: ColumnKey, label: string) => (
    <span
      className="column-resize-handle"
      aria-label={`调整${label}列宽`}
      title="拖动调整列宽，双击恢复默认；方向键微调"
      {...columnBindings(key)}
    />
  );
  const [accountId, setAccountId] = useState('');
  const [page, setPage] = useState<'files' | 'tasks'>('files');
  const [crumbs, setCrumbs] = useState([{ id: 'root', name: folderNames.root }]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const sessions = useRef(
    new Map<
      string,
      {
        rootId?: string;
        maxDepth?: number;
        files: FileEntry[];
        scope: string;
        path: string;
        name: string;
        time: string;
        complete: boolean;
        warnings: string[];
      }
    >(),
  );
  const [scope, setScope] = useState('all');
  const [scanPath, setScanPath] = useState('');
  const [limitDepth, setLimitDepth] = useState(false);
  const [scanDepth, setScanDepth] = useState('1');
  const [snapshot, setSnapshot] = useState<{
    rootId?: string;
    maxDepth?: number;
    scope: string;
    name: string;
    time: string;
    complete: boolean;
    warnings: string[];
  } | null>(null);
  const trackedTasks = useRef(new Set<string>());
  const appliedItems = useRef(new Set<string>());
  const taskReads = useRef(new Map<string, string>());
  const [permissionBusy, setPermissionBusy] = useState(false);
  const permissionVersion = useRef(0);
  const sessionKey = boot.mode + ':' + accountId;
  const activeSession = useRef(sessionKey);
  activeSession.current = sessionKey;
  const folderNamesForScan: Record<string, string> = {
    all: '全部文件',
    owned: '本人拥有',
    shared: '与我共享',
    trash: '回收站',
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const marquee = useMarquee(selected, setSelected);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState<NonNullable<ActionRequest['ownerFilter']>>('all');
  const tree = true;
  const trashView = snapshot?.scope === 'trash';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scanRequest = useRef('');
  const [scanProgress, setScanProgress] = useState({ pages: 0, items: 0 });
  useEffect(
    () =>
      api?.onScanProgress((progress) => {
        if (progress.requestId === scanRequest.current) setScanProgress(progress);
      }),
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permError, setPermError] = useState('');
  const [sort, setSort] = useState<'name' | 'createdTime' | 'modifiedTime' | 'size'>('name');
  const [descending, setDescending] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
  const [modal, setModal] = useState<'connections' | 'settings' | 'import' | 'data' | null>(null);
  const [cleanup, setCleanup] = useState<{
    kind: 'tasks' | 'account' | 'reset';
    ids?: string[];
    account?: Account;
  } | null>(null);
  const [resetText, setResetText] = useState('');
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [action, setAction] = useState<ActionRequest['kind'] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [input, setInput] = useState('');
  const [target, setTarget] = useState('');
  const [destination, setDestination] = useState('root');
  const [recursive, setRecursive] = useState(false);
  const [removeSource, setRemoveSource] = useState(false);
  const [moveToTargetRoot, setMoveToTargetRoot] = useState(false);
  const [share, setShare] = useState<ShareConfig>({ ...DEFAULT_SHARE });
  const [simpleShare, setSimpleShare] = useState(false);
  const [shareActionTitle, setShareActionTitle] = useState('权限设置');
  const [peopleText, setPeopleText] = useState('');
  const [personType, setPersonType] = useState<Collaborator['type']>('user');
  const [personRole, setPersonRole] = useState<Collaborator['role']>('writer');
  const [mapping, setMapping] = useState(false);
  const [draftSettings, setDraftSettings] = useState(DEFAULT_SETTINGS);
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  useEffect(() => {
    if (!taskDetail) return;
    let alive = true;
    api
      .task(taskDetail.id)
      .then((t) => {
        if (alive) setTaskDetail(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [taskDetail?.id, boot.tasks]);
  const requestVersion = useRef(0),
    anchor = useRef(0);
  const current = crumbs.at(-1)!;
  const account = boot.accounts.find((a) => a.id === accountId);
  const chosen = files.filter((f) => selected.has(f.id));
  const single = chosen.length === 1 ? chosen[0] : undefined;
  const notify = useCallback((s: string) => {
    setToast(s);
  }, []);
  const refresh = useCallback(async () => {
    if (!api) return;
    const b = await api.bootstrap();
    setBoot(b);
    setAccountId((id) => (b.accounts.some((a) => a.id === id) ? id : b.accounts[0]?.id || ''));
    return b;
  }, []);
  useEffect(() => {
    if (!api) {
      setError('请从桌面应用启动。网页预览不连接真实 Google 账号。');
      return;
    }
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const clearScans = (all = false) => {
    if (all) sessions.current.clear();
    else sessions.current.delete(sessionKey);
    ++requestVersion.current;
    ++permissionVersion.current;
    scanRequest.current = '';
    setFiles([]);
    setSnapshot(null);
    setSelected(new Set());
    setExpanded(new Set());
    setPermissions([]);
    setPermError('');
    setPermissionBusy(false);
    setMenu(null);
    setLoading(false);
    setSearch('');
    setError('');
    setScope('all');
    setScanPath('');
    setCrumbs([{ id: 'root', name: '全部文件' }]);
  };
  const executeCleanup = () =>
    run(async () => {
      if (!cleanup) return;
      if (cleanup.kind === 'tasks') {
        await api.deleteTasks(cleanup.ids!);
        if (cleanup.ids!.includes(taskDetail?.id || '')) setTaskDetail(null);
        for (const id of cleanup.ids!) {
          trackedTasks.current.delete(id);
          taskReads.current.delete(id);
        }
        notify(`已删除 ${cleanup.ids!.length} 条本地任务记录`);
      } else if (cleanup.kind === 'account') {
        await api.removeAccount(cleanup.account!.id);
        sessions.current.delete(boot.mode + ':' + cleanup.account!.id);
        if (accountId === cleanup.account!.id) clearScans();
        setPlan(null);
        setAction(null);
        setTaskDetail(null);
        notify('本地账号及授权已移除，历史任务记录保留');
      } else {
        await api.resetLocalData(resetText);
        clearScans(true);
        trackedTasks.current.clear();
        appliedItems.current.clear();
        taskReads.current.clear();
        setTaskDetail(null);
        setPlan(null);
        setAction(null);
        setPage('files');
        setModal(null);
        resetColumns();
        notify('本地数据已清空，网盘文件保持不变');
      }
      await refresh();
      setCleanup(null);
      setResetText('');
    });
  // Switching accounts restores this session's scan. It never calls Drive.
  useEffect(() => {
    ++requestVersion.current;
    const saved = sessions.current.get(sessionKey);
    setFiles(saved?.files || []);
    setSnapshot(saved || null);
    setScope(saved?.scope || 'all');
    setScanPath(saved?.path || '');
    setLimitDepth(saved?.maxDepth !== undefined);
    setScanDepth(String(saved?.maxDepth ?? 1));
    setCrumbs([
      { id: saved?.scope === 'trash' ? 'trash' : 'root', name: saved?.name || '全部文件' },
    ]);
    setSelected(new Set());
    setExpanded(new Set());
    setSearch('');
    setError(saved?.warnings.join('；') || '');
    setLoading(false);
  }, [sessionKey]);
  useEffect(() => {
    permissionVersion.current++;
    setPermissions(single?.permissions || []);
    setPermError('');
    setPermissionBusy(false);
  }, [accountId, single]);
  const readPermissions = () =>
    run(async () => {
      if (!single) return;
      const version = ++permissionVersion.current;
      setPermissionBusy(true);
      setPermError('');
      try {
        const result = await api.permissions(accountId, single.id);
        if (version === permissionVersion.current) {
          setPermissions(result);
          const update = (rows: FileEntry[]) =>
            rows.map((f) => (f.id === single.id ? { ...f, permissions: result } : f));
          setFiles(update);
          const saved = sessions.current.get(sessionKey);
          if (saved) saved.files = update(saved.files);
        }
      } catch (e) {
        if (version === permissionVersion.current)
          setPermError(e instanceof Error ? e.message : String(e));
      } finally {
        if (version === permissionVersion.current) setPermissionBusy(false);
      }
    });
  const directory = useMemo(
    () => directoryIndex(files, snapshot?.rootId),
    [files, snapshot?.rootId],
  );
  const fileMap = directory.byId;
  const toggleFolder = (id: string) => {
    if (fileMap.get(id)?.childrenScanned === false) {
      notify('此目录下级未扫描；请将顶部扫描范围设为指定目录，填入该目录后扫描');
      return;
    }
    setExpanded((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  // Apply completed, verified writes to this session's directory, without rescanning.
  useEffect(() => {
    for (const summary of boot.tasks) {
      if (
        !trackedTasks.current.has(summary.id) ||
        ['running', 'queued'].includes(summary.status) ||
        taskReads.current.get(summary.id) === summary.updatedAt
      )
        continue;
      taskReads.current.set(summary.id, summary.updatedAt);
      const mode = boot.mode;
      void api
        .task(summary.id)
        .then((task) => {
          const items = task.items.filter(
            (item) =>
              item.state === 'succeeded' && !appliedItems.current.has(task.id + ':' + item.file.id),
          );
          if (!items.length) return;
          for (const [key, saved] of sessions.current) {
            if (!key.startsWith(mode + ':')) continue;
            const ownerAccount = key.slice(mode.length + 1),
              source = ownerAccount === task.request.accountId;
            const oldIndex = directoryIndex(saved.files),
              rows = new Map(saved.files.map((f) => [f.id, f]));
            for (const item of items) {
              if (
                source &&
                ((task.request.kind === 'trash' && saved.scope !== 'trash') ||
                  (task.request.kind === 'restore' && saved.scope === 'trash') ||
                  (task.request.kind === 'transfer' && task.request.removeSource))
              ) {
                const queue = [item.file.id];
                for (let i = 0; i < queue.length; i++) {
                  rows.delete(queue[i]);
                  queue.push(...(oldIndex.children.get(queue[i]) || []));
                }
              } else if (item.resultFile) {
                const f = {
                  ...item.resultFile,
                  childrenScanned: rows.get(item.resultFile.id)?.childrenScanned,
                  ownedByMe: item.resultFile.owners?.length
                    ? item.resultFile.owners.some((o) => {
                        const a = boot.accounts.find((a) => a.id === ownerAccount);
                        return (
                          a &&
                          ((o.permissionId && o.permissionId === a.permissionId) ||
                            o.emailAddress?.toLowerCase() === a.email.toLowerCase())
                        );
                      })
                    : source
                      ? item.resultFile.ownedByMe
                      : undefined,
                };
                const existing = rows.has(f.id);
                const createdInScope =
                  source &&
                  ['copy', 'mkdir'].includes(task.request.kind) &&
                  saved.scope !== 'trash' &&
                  (saved.scope === 'all' ||
                    f.parents.some((p) => oldIndex.byId.has(p) || p === parseId(saved.path)));
                if (existing || createdInScope) rows.set(f.id, f);
              }
            }
            saved.files = [...rows.values()];
            if (key === activeSession.current) {
              setFiles(saved.files);
              setSelected((old) => new Set([...old].filter((id) => rows.has(id))));
              setPermissions([]);
            }
          }
          for (const item of items) appliedItems.current.add(task.id + ':' + item.file.id);
        })
        .catch(() => {
          taskReads.current.delete(summary.id);
        });
    }
  }, [boot.tasks, boot.mode]);
  const load = async () => {
    if (!accountId || loading) return;
    let parent = scope,
      name = folderNamesForScan[scope];
    if (scope === 'folder') {
      const raw = scanPath.trim();
      parent =
        parseId(raw) ||
        (raw !== ORPHAN_NODE && (fileMap.has(raw) || raw === snapshot?.rootId) ? raw : '');
      if (!parent) {
        notify('请填写文件夹链接或 ID');
        return;
      }
      name = fileMap.get(parent)?.name || raw;
    }
    const maxDepth = limitDepth && scope !== 'trash' ? Number(scanDepth) : undefined;
    if (
      maxDepth !== undefined &&
      (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1000)
    ) {
      notify('最大扫描层级须为1到1000的整数');
      return;
    }
    const version = ++requestVersion.current,
      key = sessionKey;
    scanRequest.current = key + ':' + version;
    setScanProgress({ pages: 0, items: 0 });
    setLoading(true);
    setError('');
    try {
      const result = await api.list(
        accountId,
        scope === 'trash' ? 'root' : parent,
        true,
        scope === 'trash',
        scanRequest.current,
        maxDepth,
      );
      const next = {
        ...result,
        scope,
        path: scanPath,
        name,
        time: new Date().toLocaleString('zh-CN'),
      };
      sessions.current.set(key, next);
      if (version !== requestVersion.current) return;
      setFiles(result.files);
      setSnapshot(next);
      setSelected(new Set());
      setExpanded(new Set());
      setSearch('');
      setCrumbs([{ id: scope === 'trash' ? 'trash' : 'root', name }]);
      setError(result.complete ? '' : '扫描不完整：' + result.warnings.join('；'));
      notify('扫描完成，' + result.files.length + ' 项；展开和搜索使用本次目录');
    } catch (e) {
      if (version === requestVersion.current)
        setError(
          (e instanceof Error ? e.message : String(e)) + (snapshot ? '；保留上次扫描结果' : ''),
        );
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };
  const sizeText = (f: FileEntry) =>
    f.childrenScanned === false
      ? '下级未扫描'
      : directorySizeLabel(directory.sizes.get(f.id)!, snapshot?.complete ?? true);
  const ownerSummary = useMemo(() => {
    const counts = new Map<string, number>(),
      branches = new Set<string>();
    const order = [...(directory.children.get('') || [])];
    for (let i = 0; i < order.length; i++) {
      const id = order[i],
        f = directory.byId.get(id)!;
      const matches = id !== ORPHAN_NODE && matchesOwner(f, ownerFilter, account);
      counts.set(id, matches && f.mimeType !== FOLDER ? 1 : 0);
      if (matches) branches.add(id);
      order.push(...(directory.children.get(id) || []));
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i],
        parent = directory.parent.get(id);
      if (parent) {
        counts.set(parent, (counts.get(parent) || 0) + (counts.get(id) || 0));
        if (branches.has(id)) branches.add(parent);
      }
    }
    return { counts, branches };
  }, [directory, ownerFilter, account?.email, account?.permissionId]);
  const matchesFilters = useCallback(
    (f: FileEntry) =>
      (f.id === ORPHAN_NODE
        ? ownerSummary.branches.has(f.id)
        : matchesOwner(f, ownerFilter, account)) &&
      (!search ||
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.id.includes(search) ||
        f.owners?.some((o) =>
          (o.emailAddress || o.displayName || '').toLowerCase().includes(search.toLowerCase()),
        ) ||
        permissionRows(f).join(' ').toLowerCase().includes(search.toLowerCase())) &&
      (filter === 'all' ||
        (filter === 'external' && hasExternalPermission(f)) ||
        (filter === 'permissions-unknown' && f.permissions === undefined) ||
        (filter === 'owned' && f.ownedByMe) ||
        (filter === 'folder' && f.mimeType === FOLDER) ||
        (filter === 'document' && f.mimeType.includes('google-apps') && f.mimeType !== FOLDER) ||
        (filter === 'other' && !f.mimeType.includes('google-apps'))),
    [ownerSummary, ownerFilter, account?.email, account?.permissionId, search, filter],
  );
  const visible = useMemo(() => {
    const base = fileMap.has(current.id) ? current.id : '';
    const ids: string[] = [],
      queue = [...(directory.children.get(base) || [])];
    const cmp = (aid: string, bid: string) => {
      if (aid === ORPHAN_NODE || bid === ORPHAN_NODE)
        return aid === bid ? 0 : aid === ORPHAN_NODE ? 1 : -1;
      const a = fileMap.get(aid)!,
        b = fileMap.get(bid)!;
      if ((a.mimeType === FOLDER) !== (b.mimeType === FOLDER))
        return a.mimeType === FOLDER ? -1 : 1;
      const av = directory.sizes.get(aid)!.bytes,
        bv = directory.sizes.get(bid)!.bytes;
      const diff =
        sort === 'size'
          ? av > bv
            ? 1
            : av < bv
              ? -1
              : 0
          : collator.compare(
              sort === 'name' ? a.name : a[sort] || '',
              sort === 'name' ? b.name : b[sort] || '',
            );
      return descending ? -diff : diff;
    };
    // Iterative traversal stays safe even for deeply nested folder trees.
    const stack = queue.sort(cmp).reverse();
    while (stack.length) {
      const id = stack.pop()!;
      ids.push(id);
      if (
        !tree ||
        search ||
        filter !== 'all' ||
        expanded.has(id) ||
        (id !== ORPHAN_NODE && !matchesOwner(fileMap.get(id)!, ownerFilter, account))
      )
        for (const child of [...(directory.children.get(id) || [])].sort(cmp).reverse()) {
          stack.push(child);
        }
    }
    let list = ids.map((id) => fileMap.get(id)!).filter(matchesFilters);
    if (!tree || search || filter !== 'all') list.sort((a, b) => cmp(a.id, b.id));
    return list;
  }, [
    files,
    directory,
    ownerSummary,
    matchesFilters,
    current.id,
    search,
    filter,
    ownerFilter,
    account?.email,
    account?.permissionId,
    tree,
    expanded,
    sort,
    descending,
  ]);
  // Statistics cover all matching descendants, independent of tree expansion or virtual rendering.
  const totals = useMemo(() => {
    const base = fileMap.has(current.id) ? current.id : '';
    const ids = [...(directory.children.get(base) || [])];
    const matching: FileEntry[] = [];
    for (let i = 0; i < ids.length; i++) {
      const f = fileMap.get(ids[i])!;
      if (f.id !== ORPHAN_NODE && matchesFilters(f)) matching.push(f);
      ids.push(...(directory.children.get(f.id) || []));
    }
    return directoryTotals(directoryIndex(matching));
  }, [directory, current.id, matchesFilters]);
  const selectableVisible = visible.filter(
    (f) => f.id !== ORPHAN_NODE && matchesOwner(f, ownerFilter, account),
  );
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((f) => selected.has(f.id));
  const visibleIds = new Set(selectableVisible.map((f) => f.id));
  const hiddenSelected = [...selected].filter((id) => !visibleIds.has(id)).length;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 42,
    getItemKey: (i) => visible[i].id,
    overscan: 12,
    enabled: true,
    useFlushSync: false,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const topPadding = virtualRows[0]?.start || 0;
  const bottomPadding = virtualRows.length
    ? virtualizer.getTotalSize() - virtualRows.at(-1)!.end
    : 0;
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [search, filter, ownerFilter, current.id, accountId]);
  useEffect(() => {
    setSelected((old) => {
      const next = new Set(
        [...old].filter((id) => {
          const file = fileMap.get(id);
          return file && matchesOwner(file, ownerFilter, account);
        }),
      );
      return next.size === old.size ? old : next;
    });
  }, [ownerFilter, files, account?.email, account?.permissionId]);
  const navigate = (id: string, name: string, reset = false) => {
    setPage('files');
    setSearch('');
    setExpanded(new Set());
    if (!fileMap.has(id)) {
      notify('此目录未包含在本次扫描中，请在顶部指定目录后扫描');
      return;
    }
    setSelected(new Set());
    setCrumbs((c) => (reset ? [c[0], { id, name }] : [...c, { id, name }]));
  };
  const switchAccount = (a: Account) => {
    setAccountId(a.id);
    setCrumbs([{ id: 'root', name: folderNames.root }]);
    setSearch('');
    setSelected(new Set());
    setPage('files');
  };
  const select = (
    f: FileEntry,
    index: number,
    e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
    checkbox = false,
  ) => {
    if (f.id === ORPHAN_NODE || !matchesOwner(f, ownerFilter, account)) return;
    if (marquee.dragged.current) {
      marquee.dragged.current = false;
      return;
    }
    setSelected((old) => {
      const n = new Set(checkbox || e.ctrlKey || e.metaKey ? old : []);
      if (e.shiftKey) {
        const lo = Math.min(anchor.current, index),
          hi = Math.max(anchor.current, index);
        visible
          .slice(lo, hi + 1)
          .filter((x) => x.id !== ORPHAN_NODE && matchesOwner(x, ownerFilter, account))
          .forEach((x) => n.add(x.id));
      } else {
        if (n.has(f.id)) n.delete(f.id);
        else n.add(f.id);
        anchor.current = index;
      }
      return n;
    });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input,textarea,select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && page === 'files' && !modal && !action) {
        e.preventDefault();
        setSelected(new Set(selectableVisible.map((f) => f.id)));
      }
      if (e.key === 'Escape') {
        setMenu(null);
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, page, modal, action]);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);
  const openAction = (kind: ActionRequest['kind'], f?: FileEntry) => {
    if (f) setSelected(new Set([f.id]));
    setAction(kind);
    setPlan(null);
    setRecursive(false);
    setRemoveSource(false);
    setMoveToTargetRoot(false);
    setShare({ ...DEFAULT_SHARE });
    setShareActionTitle('高级组合权限设置');
    setSimpleShare(false);
    setPeopleText('');
    setMapping(false);
    setPersonRole('writer');
    setPersonType('user');
    setInput(kind === 'rename' ? (f || single)?.name || '' : '');
    setDestination(['root', 'owned', 'shared', 'trash'].includes(current.id) ? 'root' : current.id);
    setTarget(boot.accounts.find((a) => a.id !== accountId)?.id || '');
    setMenu(null);
  };
  const setPermissionPreset = (config: Partial<ShareConfig>) => {
    setShare({ ...DEFAULT_SHARE, ...config });
    setSimpleShare(true);
    setShareActionTitle(
      config.collaborators === 'add'
        ? '批量添加多个邮箱'
        : config.collaborators === 'update'
          ? '批量修改已有邮箱角色'
          : config.collaborators === 'remove'
            ? '批量移除指定邮箱'
            : config.collaborators === 'replace'
              ? '批量替换协作者名单'
              : config.public === 'off'
                ? '批量关闭链接访问'
                : config.public === 'reader'
                  ? '批量开启链接访问'
                  : config.removeGroups
                    ? '批量移除群组共享'
                    : config.removeDomains
                      ? '批量移除域共享'
                      : config.writersCanShare === 'no'
                        ? '编辑者再次分享设置'
                        : '查看者复制、下载与打印设置',
    );
  };
  const refreshActionFiles = async (targets: FileEntry[]) => {
    const key = sessionKey,
      fresh: FileEntry[] = [];
    for (let offset = 0; offset < targets.length; offset += 6)
      fresh.push(
        ...(await Promise.all(
          targets.slice(offset, offset + 6).map((f) => api.inspect(accountId, f.id, f.resourceKey)),
        )),
      );
    if (activeSession.current !== key) throw new Error('账号已切换，请重新选择文件');
    const byId = new Map(fresh.map((f) => [f.id, f]));
    const update = (rows: FileEntry[]) =>
      rows.map((f) =>
        byId.has(f.id) ? { ...f, ...byId.get(f.id), childrenScanned: f.childrenScanned } : f,
      );
    const saved = sessions.current.get(key);
    if (saved) saved.files = update(saved.files);
    setFiles((old) => update(old));
    return fresh;
  };
  const operationProblem = (kind: ActionRequest['kind'], targets = chosen, cfg?: ShareConfig) => {
    if (kind === 'mkdir') {
      if (!accountId) return '请先连接账号';
      const parent = fileMap.get(current.id);
      return parent
        ? actionProblem(kind, parent, account)
        : trashView
          ? '回收站中不能新建目录'
          : undefined;
    }
    const reason = selectionProblem(kind, targets, account, cfg);
    if (reason) return reason;
    if (kind === 'transfer' && !boot.accounts.some((a) => a.id !== accountId && a.ready))
      return '请先连接另一个目标账号';
  };
  const begin = (kind: ActionRequest['kind'], f?: FileEntry, config?: Partial<ShareConfig>) =>
    run(async () => {
      const targets = f ? [f] : chosen,
        cfg = config ? { ...DEFAULT_SHARE, ...config } : undefined;
      const cachedReason = operationProblem(kind, targets, cfg);
      if (cachedReason) throw new Error(cachedReason);
      const fresh = await refreshActionFiles(
        kind === 'mkdir'
          ? [
              fileMap.get(current.id) || {
                id: 'root',
                name: '根目录',
                mimeType: FOLDER,
                parents: [],
              },
            ]
          : targets,
      );
      const reason =
        kind === 'mkdir'
          ? actionProblem(kind, fresh[0], account)
          : operationProblem(kind, fresh, cfg);
      if (reason) throw new Error(reason);
      openAction(kind, f);
      if (config) setPermissionPreset(config);
    });
  const permissionAction = (config: Partial<ShareConfig>) => begin('share', undefined, config);
  const preview = () =>
    run(async () => {
      let cfg = {
        ...share,
        people: share.clearUsers ? [] : parsePeople(peopleText, personType, personRole),
      };
      if (mapping && action === 'share') {
        const mappings = peopleText
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((line, index) => {
            const [url, email, role = 'writer'] = line.split(/[\t,，]+/).map((x) => x.trim());
            const id = parseId(url);
            if (!id || !email || !['reader', 'commenter', 'writer'].includes(role))
              throw new Error(`第 ${index + 1} 行格式无效，需要：文件链接,邮箱,角色`);
            return {
              fileId: id,
              person: { email, type: personType, role: role as Collaborator['role'] },
            };
          });
        if (mappings.some((m) => !selected.has(m.fileId)))
          throw new Error('映射文件必须在当前选中范围内，请先导入或选择这些文件');
        cfg = { ...cfg, people: [], mappings };
      }
      const req: ActionRequest = {
        kind: action!,
        accountId,
        ids: [...selected],
        recursive,
        ownerFilter,
        targetAccountId: target,
        removeSource,
        moveToTargetRoot: action === 'transfer' && moveToTargetRoot,
        name: input.trim() || undefined,
        destination: parseId(destination) || destination,
        share: cfg,
      };
      setPlan(await api.preview(req));
    });
  const submit = () =>
    run(async () => {
      if (!plan) return;
      const submitted = await api.submit(plan.id);
      trackedTasks.current.add(submitted.id);
      setAction(null);
      setPlan(null);
      await refresh();
      setPage('tasks');
      notify('任务已提交，执行身份已固定');
    });
  const importLinks = () =>
    run(async () => {
      const rows = [
        ...new Set(
          input
            .split(/\s+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ];
      const out: FileEntry[] = [],
        invalid: string[] = [];
      for (const row of rows) {
        const id = parseId(row);
        if (!id) {
          invalid.push(row);
          continue;
        }
        try {
          if (!out.some((x) => x.id === id))
            out.push(
              await api.inspect(
                accountId,
                id,
                row.includes('://')
                  ? new URL(row).searchParams.get('resourcekey') || undefined
                  : undefined,
              ),
            );
        } catch {
          invalid.push(row);
        }
      }
      if (!out.length) throw new Error('没有可访问的有效文件');
      const merged = new Map(files.map((f) => [f.id, f]));
      out.forEach((f) => merged.set(f.id, f));
      const imported = [...merged.values()];
      setFiles(imported);
      const saved = sessions.current.get(sessionKey);
      if (saved) saved.files = imported;
      setSelected(new Set(out.map((f) => f.id)));
      setCrumbs([{ id: 'root', name: snapshot?.name || '导入的文件' }]);
      setSearch('');
      setExpanded(new Set());
      setModal(null);
      if (invalid.length)
        setError(
          `${invalid.length} 个链接无效或当前账号无法访问：${invalid.slice(0, 5).join('；')}`,
        );
      notify(`已导入 ${out.length} 个去重文件`);
    });
  const totalTasks = boot.tasks.filter(
    (t) => t.status === 'running' || t.status === 'queued',
  ).length;
  const setOrder = (key: typeof sort) => {
    if (sort === key) setDescending(!descending);
    else {
      setSort(key);
      setDescending(false);
    }
  };
  const topAction = (
    kind: ActionRequest['kind'],
    label: string,
    icon: ReactNode,
    disabled = !selected.size,
  ) => (
    <Button
      title={operationProblem(kind)}
      disabled={disabled || busy || !!operationProblem(kind)}
      onClick={() => begin(kind)}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <div className="app-shell compact-shell">
      <aside className="accounts-rail">
        <div className="workspace-brand">
          <span className="brand-mark">
            <img src="./app-icon.png" alt="" width="44" height="44" draggable={false} />
          </span>
          <div>
            <strong>云盘工作台</strong>
            <small>DRIVE WORKBENCH</small>
          </div>
        </div>
        <div className="rail-title">
          <Cloud size={20} />
          <strong>Google 账号</strong>
          {boot.mode === 'demo' && <Badge tone="amber">演示</Badge>}
        </div>
        <div className="account-list" role="navigation" aria-label="Google 账号">
          {boot.accounts.map((a) => (
            <button
              key={a.id}
              className={a.id === accountId ? 'account-item active' : 'account-item'}
              onClick={() => switchAccount(a)}
              title={a.email}
            >
              <AccountAvatar account={a} />
              <span>
                <strong>{a.name || a.email}</strong>
                <small>{a.email}</small>
              </span>
            </button>
          ))}
          {!boot.accounts.length && <p className="rail-empty">请添加 Google 账号</p>}
        </div>
        <div className="rail-settings">
          {boot.update?.status === 'ready' && (
            <Button primary onClick={() => setUpdateConfirm(true)}>
              <RefreshCw size={15} />
              重启更新 {boot.update.latest}
            </Button>
          )}
          <Button onClick={() => setModal('connections')}>
            <KeyRound size={16} />
            账号与授权
          </Button>
          <Button
            onClick={() => {
              setDraftSettings(boot.settings);
              setModal('settings');
            }}
          >
            <Settings2 size={16} />
            设置
          </Button>
        </div>
      </aside>
      <main className="directory-workspace">
        <header className="workspace-header">
          <div className="workspace-identity">
            <h1>文件工作台</h1>
            <p>{account?.email || '连接账号，开始管理云端文件'}</p>
          </div>
          {snapshot && (
            <section
              className="scan-summary"
              aria-label="目录统计"
              title="统计当前目录内符合筛选的全部已扫描项目，包含折叠后代；大小与占用只累加匹配文件，避免父子目录重复计入。"
            >
              <div>
                <strong>
                  {search || filter !== 'all' || ownerFilter !== 'all' || crumbs.length > 1
                    ? '当前筛选：'
                    : '统计对象：'}
                </strong>
                <span>
                  {totals.files} 个文件 · {totals.folders} 个文件夹
                </span>
                <span className="summary-separator">|</span>
                <span>{directorySizeLabel(totals, snapshot.complete)}</span>
              </div>
              <div>
                <strong>扫描时间：</strong>
                <span>{snapshot.time}</span>
                <span className="summary-storage">{quotaSizeLabel(totals)}</span>
                {snapshot.maxDepth !== undefined && (
                  <span className="depth-summary">
                    最多 {snapshot.maxDepth} 层 · 仅统计已扫描部分
                  </span>
                )}
              </div>
            </section>
          )}
          {!snapshot && (
            <span className="workspace-context">
              <span />
              {boot.mode === 'demo' ? '演示工作空间' : '当前账号工作空间'}
            </span>
          )}
        </header>
        <div className="scan-toolbar">
          <select
            aria-label="扫描范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={loading}
          >
            <option value="all">全部文件</option>
            <option value="folder">指定目录</option>
            <option value="trash">回收站</option>
          </select>
          <input
            className="scan-path"
            aria-label="扫描路径"
            placeholder={
              scope === 'folder'
                ? '文件夹链接或 ID（root 为根目录）'
                : '当前账号 · ' + (folderNamesForScan[scope] || '')
            }
            value={scope === 'folder' ? scanPath : ''}
            disabled={scope !== 'folder' || loading}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load();
            }}
          />
          <div
            className="scan-depth-control"
            title={
              scope === 'trash'
                ? '回收站为平面列表，不按目录层级扫描'
                : '1为当前层，2为当前层及下一层；不勾选则扫描全部'
            }
          >
            <label>
              <input
                type="checkbox"
                checked={limitDepth}
                disabled={loading || scope === 'trash'}
                onChange={(e) => setLimitDepth(e.target.checked)}
              />
              最大扫描层级
            </label>
            <input
              type="number"
              aria-label="扫描层级数"
              min="1"
              max="1000"
              step="1"
              value={scanDepth}
              disabled={!limitDepth || loading || scope === 'trash'}
              onChange={(e) => setScanDepth(e.target.value)}
            />
          </div>
          <Button primary disabled={!accountId || loading || busy} onClick={() => void load()}>
            {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{' '}
            {loading ? '扫描中…' : '扫描'}
          </Button>
        </div>

        <div className="file-toolbar compact-toolbar">
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索文件"
              placeholder="搜索名称、ID 或授权邮箱"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="icon-button" onClick={() => setSearch('')}>
                <X size={14} />
              </button>
            )}
          </div>
          <select
            aria-label="所有者筛选"
            value={ownerFilter}
            onChange={(e) => {
              setOwnerFilter(e.target.value as typeof ownerFilter);
              setSelected(new Set());
            }}
          >
            <option value="mine">所有者：我</option>
            <option value="others">所有者：他人</option>
            <option value="all">所有者：全部</option>
            <option value="unknown">所有者：未知</option>
          </select>
          <select
            aria-label="文件类型筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部类型</option>
            <option value="external">有外部授权</option>
            <option value="permissions-unknown">未提供权限明细</option>
            <option value="folder">文件夹</option>
            <option value="document">Google 文档</option>
            <option value="other">其他文件</option>
          </select>
          <button
            className="text-tool"
            onClick={() =>
              setExpanded(
                new Set(
                  [...fileMap.values()].filter((f) => f.mimeType === FOLDER).map((f) => f.id),
                ),
              )
            }
          >
            展开全部
          </button>
          <button className="text-tool" onClick={() => setExpanded(new Set())}>
            收起
          </button>
        </div>
        <div className="directory-location">
          <button
            className="text-tool"
            onClick={() =>
              setSelected(
                allVisibleSelected
                  ? new Set()
                  : new Set([...selected, ...selectableVisible.map((f) => f.id)]),
              )
            }
          >
            {allVisibleSelected ? '清空所有' : '全选可见'}
          </button>
          <button className="text-tool fit-columns" onClick={resetColumns}>
            自适应列宽
          </button>
          {snapshot && (
            <button
              className="text-tool"
              disabled={loading || busy}
              onClick={() => {
                clearScans();
                notify('已清空本账号扫描结果，网盘文件保持不变');
              }}
            >
              清空扫描
            </button>
          )}
          <div className="local-crumbs">
            {crumbs.map((c, i) => (
              <span key={c.id}>
                <button
                  onClick={() => {
                    setCrumbs((x) => x.slice(0, i + 1));
                    setSelected(new Set());
                  }}
                >
                  {c.name}
                </button>
                {i < crumbs.length - 1 && <ChevronRight size={12} />}
              </span>
            ))}
          </div>
        </div>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}
        <section className="directory-table">
          {' '}
          <div className="table-scroll" ref={scrollRef} onPointerDown={marquee.onPointerDown}>
            <table
              className="file-table"
              style={
                columnWidths
                  ? {
                      width:
                        TABLE_FIXED_WIDTH +
                        Object.values(columnWidths).reduce((sum, value) => sum + value, 0),
                      minWidth: 0,
                    }
                  : undefined
              }
            >
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="全选当前可见文件"
                      checked={allVisibleSelected}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? new Set([...selected, ...selectableVisible.map((f) => f.id)])
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th data-column="name" style={{ width: columnWidths?.name ?? 280 }}>
                    <button onClick={() => setOrder('name')}>
                      名称 <ArrowUpDown size={12} />
                    </button>
                    {columnHandle('name', '名称')}
                  </th>
                  <th data-column="size" style={{ width: columnWidths?.size ?? 120 }}>
                    <button onClick={() => setOrder('size')}>大小</button>
                    {columnHandle('size', '大小')}
                  </th>
                  <th data-column="createdTime" style={{ width: columnWidths?.createdTime ?? 104 }}>
                    <button onClick={() => setOrder('createdTime')}>创建时间</button>
                    {columnHandle('createdTime', '创建时间')}
                  </th>
                  <th
                    data-column="modifiedTime"
                    style={{ width: columnWidths?.modifiedTime ?? 104 }}
                  >
                    <button onClick={() => setOrder('modifiedTime')}>
                      修改时间 <ArrowDown size={14} />
                    </button>
                    {columnHandle('modifiedTime', '修改时间')}
                  </th>
                  <th data-column="owner" style={{ width: columnWidths?.owner ?? 100 }}>
                    所有者{columnHandle('owner', '所有者')}
                  </th>
                  <th
                    data-column="permissions"
                    style={{ width: columnWidths?.permissions ?? 'auto', minWidth: 0 }}
                  >
                    邮箱与权限{columnHandle('permissions', '邮箱与权限')}
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {topPadding > 0 && (
                  <tr className="virtual-spacer" aria-hidden="true">
                    <td colSpan={8} style={{ height: topPadding }} />
                  </tr>
                )}
                {virtualRows.map((v) => {
                  const index = v.index,
                    f = visible[index];
                  if (f.id === ORPHAN_NODE)
                    return (
                      <tr
                        key={f.id}
                        ref={virtualizer.measureElement}
                        data-index={v.index}
                        className="orphan-group"
                      >
                        <td />
                        <td colSpan={7}>
                          <button
                            className="text-tool"
                            aria-label={`展开 ${f.name}`}
                            onClick={() =>
                              setExpanded((old) => {
                                const next = new Set(old);
                                next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                                return next;
                              })
                            }
                          >
                            {expanded.has(f.id) ? '▾' : '▸'} {f.name} ·{' '}
                            {ownerSummary.counts.get(f.id) || 0} 个文件 · {sizeText(f)}
                          </button>
                        </td>
                      </tr>
                    );
                  return (
                    <tr
                      key={f.id}
                      ref={virtualizer.measureElement}
                      data-index={v.index}
                      data-file-id={f.id}
                      data-selectable="true"
                      className={selected.has(f.id) ? 'is-selected' : ''}
                      onClick={() => {
                        if (marquee.dragged.current) {
                          marquee.dragged.current = false;
                          return;
                        }
                        if (f.mimeType === FOLDER) toggleFolder(f.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected(new Set([f.id]));
                        setMenu({
                          x: Math.min(e.clientX, window.innerWidth - 210),
                          y: Math.min(e.clientY, window.innerHeight - 320),
                          file: f,
                        });
                      }}
                    >
                      <td className="check-cell">
                        <input
                          aria-label={`选择 ${f.name}`}
                          type="checkbox"
                          checked={selected.has(f.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            select(
                              f,
                              index,
                              { shiftKey: (e.nativeEvent as MouseEvent).shiftKey },
                              true,
                            )
                          }
                        />
                      </td>
                      <td>
                        <div
                          className="file-name"
                          style={{
                            paddingLeft: tree
                              ? Math.max(
                                  0,
                                  (directory.depth.get(f.id) || 0) -
                                    (directory.depth.get(current.id) !== undefined
                                      ? directory.depth.get(current.id)! + 1
                                      : 0),
                                ) * 18
                              : 0,
                          }}
                        >
                          {tree && f.mimeType === FOLDER && (
                            <button
                              className="tree-toggle"
                              aria-label={`展开 ${f.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFolder(f.id);
                              }}
                            >
                              {expanded.has(f.id) ? (
                                <ChevronDown size={13} />
                              ) : (
                                <ChevronRight size={13} />
                              )}
                            </button>
                          )}
                          {tree && f.mimeType !== FOLDER && (
                            <span className="tree-toggle-placeholder" aria-hidden="true" />
                          )}
                          <IconFile file={f} />
                          <span
                            className="name-content"
                            title={directoryPath(f.id, directory) + '\n' + f.id}
                          >
                            {f.mimeType === FOLDER ? (
                              <button
                                className="folder-name"
                                aria-expanded={expanded.has(f.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFolder(f.id);
                                }}
                              >
                                {f.name}
                              </button>
                            ) : (
                              <a
                                href={fileLink(f)}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void api.openExternal(fileLink(f));
                                }}
                              >
                                {f.name}
                              </a>
                            )}
                            {search && <small>{directoryPath(f.id, directory)}</small>}
                          </span>
                          {f.mimeType === FOLDER && (
                            <span
                              className="folder-count"
                              title={`当前所有者范围 ${ownerSummary.counts.get(f.id) || 0} 个文件；扫描后代共 ${directory.sizes.get(f.id)!.files} 个文件、${directory.sizes.get(f.id)!.folders} 个文件夹`}
                            >
                              {f.childrenScanned === false
                                ? '未扫描'
                                : ownerSummary.counts.get(f.id) || 0}
                            </span>
                          )}
                          {f.mimeType === SHORTCUT && <ExternalLink size={11} />}
                        </div>
                      </td>
                      <td
                        title={
                          f.mimeType === FOLDER
                            ? `后代 ${directory.sizes.get(f.id)!.files} 个文件、${directory.sizes.get(f.id)!.folders} 个文件夹；仅汇总本次扫描可见内容`
                            : `${f.size ?? 'API 未提供'} 字节；${quotaSizeLabel(directory.sizes.get(f.id)!)}`
                        }
                      >
                        <span>{sizeText(f)}</span>
                        {directory.sizes.get(f.id)!.quotaBytes !==
                          directory.sizes.get(f.id)!.bytes && (
                          <small
                            className="quota-size"
                            title="存储占用；完整信息在右侧文件详情查看"
                          >
                            {quotaSizeLabel(directory.sizes.get(f.id)!)}
                          </small>
                        )}
                      </td>
                      <td className="date-cell">{dateLabel(f.createdTime)}</td>
                      <td>{dateLabel(f.modifiedTime)}</td>
                      <td
                        className="owner-cell"
                        title={
                          f.owners?.map((o) => o.emailAddress || o.displayName).join('、') ||
                          '所有者未知'
                        }
                      >
                        {ownershipOf(f, account) === 'mine'
                          ? '我'
                          : f.owners
                              ?.map((o) => o.emailAddress || o.displayName)
                              .filter(Boolean)
                              .join('、') || (f.driveId ? '共享云端硬盘' : '所有者未知')}
                      </td>
                      <td className="permission-cell">
                        <div className="permission-cell-content">
                          <div
                            className="row-permissions"
                            tabIndex={0}
                            aria-label={`${f.name} 的权限列表`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {permissionRows(f, false).map((line, i) => (
                              <span key={i} title={line}>
                                {line}
                              </span>
                            ))}
                          </div>
                          {permissionRows(f, false).length > 4 && (
                            <small className="permission-count">
                              {permissionRows(f, false).length} 项
                            </small>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="row-tools">
                          <button
                            className="icon-button copy-row-link"
                            title={`复制 ${f.name} 的链接`}
                            onClick={(e) => {
                              e.stopPropagation();
                              run(async () => {
                                await api.copyLinks([fileLink(f)]);
                                notify('链接已复制');
                              });
                            }}
                          >
                            <Link size={16} />
                          </button>
                          <button
                            className="icon-button row-menu"
                            title={`${f.name} 更多操作`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(new Set([f.id]));
                              setMenu({
                                x: Math.min(e.clientX, window.innerWidth - 210),
                                y: Math.min(e.clientY, window.innerHeight - 320),
                                file: f,
                              });
                            }}
                          >
                            <MoreHorizontal size={17} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {bottomPadding > 0 && (
                  <tr className="virtual-spacer" aria-hidden="true">
                    <td colSpan={8} style={{ height: bottomPadding }} />
                  </tr>
                )}
              </tbody>
            </table>
            {loading && (
              <div className="loading-overlay">
                <LoaderCircle size={24} className="spin" />
                正在读取完整目录…
                {scanProgress.pages > 0 &&
                  ` 第 ${scanProgress.pages} 页 · 已读 ${scanProgress.items} 项`}
              </div>
            )}
            {!loading && !visible.length && (
              <div className="empty-state">
                <Folder size={42} />
                <h3>
                  {accountId
                    ? snapshot
                      ? '没有匹配的文件'
                      : '点击扫描，生成本次目录'
                    : boot.connections.length
                      ? '完成 Google 账号授权'
                      : '连接你的第一个账号'}
                </h3>
                <p>
                  {accountId
                    ? snapshot
                      ? '调整搜索或筛选，或重新扫描。'
                      : '扫描一次后，展开、搜索、排序均在本地完成。'
                    : boot.connections.length
                      ? '授权配置已导入，请到“账号与授权”完成浏览器登录。'
                      : '导入桌面 OAuth 配置，登录后开始管理网盘。'}
                </p>
                {!accountId && (
                  <Button primary onClick={() => setModal('connections')}>
                    <KeyRound size={16} />
                    账号与授权
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>
        <div className="directory-status">
          <span>
            {files.length} 项 · 显示 {selectableVisible.length} 项
            {selected.size
              ? ' · 已选 ' +
                selected.size +
                ' 项' +
                (hiddenSelected ? '（含折叠/筛选隐藏 ' + hiddenSelected + ' 项）' : '')
              : ''}
          </span>
          <span title="只汇总本次扫描可见的文件；未提供大小的项目单独计数">
            文件夹大小为{snapshot?.maxDepth ? '已扫描后代汇总' : '后代汇总'}
            {snapshot && !snapshot.complete ? ' · 结果不完整' : ''}
          </span>
        </div>
      </main>
      <aside className="operations-console">
        <div className="console-heading">
          <strong>操作</strong>
          <span>已选 {selected.size} 项</span>
        </div>
        <div className="console-body">
          {!selected.size && (
            <p className="selection-hint">选择文件后，可管理权限或执行文件操作。</p>
          )}
          {chosen.length > 0 && (
            <button
              className="text-tool refresh-operation-access"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await refreshActionFiles(chosen);
                  notify('已刷新 ' + chosen.length + ' 项操作权限');
                })
              }
            >
              刷新操作权限
            </button>
          )}
          <div className="console-actions">
            <section className="permission-tools" aria-label="批量权限管理">
              <h3>
                <ShieldCheck size={15} />
                权限管理
              </h3>
              <div className="action-grid">
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ collaborators: 'add' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ collaborators: 'add' },
                  })}
                  onClick={() => permissionAction({ collaborators: 'add' })}
                >
                  添加多个邮箱
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ collaborators: 'update' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ collaborators: 'update' },
                  })}
                  onClick={() => permissionAction({ collaborators: 'update' })}
                >
                  修改邮箱角色
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ collaborators: 'remove' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ collaborators: 'remove' },
                  })}
                  onClick={() => permissionAction({ collaborators: 'remove' })}
                >
                  移除指定邮箱
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ collaborators: 'replace' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ collaborators: 'replace' },
                  })}
                  onClick={() => permissionAction({ collaborators: 'replace' })}
                >
                  替换协作者名单
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ public: 'reader' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ public: 'reader' },
                  })}
                  onClick={() => permissionAction({ public: 'reader' })}
                >
                  开启链接访问
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, { ...DEFAULT_SHARE, ...{ public: 'off' } })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ public: 'off' },
                  })}
                  onClick={() => permissionAction({ public: 'off' })}
                >
                  关闭链接访问
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ removeGroups: true },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ removeGroups: true },
                  })}
                  onClick={() => permissionAction({ removeGroups: true })}
                >
                  移除群组共享
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ removeDomains: true },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ removeDomains: true },
                  })}
                  onClick={() => permissionAction({ removeDomains: true })}
                >
                  移除域共享
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ writersCanShare: 'no' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ writersCanShare: 'no' },
                  })}
                  onClick={() => permissionAction({ writersCanShare: 'no' })}
                >
                  编辑者分享限制
                </Button>
                <Button
                  disabled={
                    busy ||
                    !!operationProblem('share', chosen, {
                      ...DEFAULT_SHARE,
                      ...{ copyRestriction: 'yes' },
                    })
                  }
                  title={operationProblem('share', chosen, {
                    ...DEFAULT_SHARE,
                    ...{ copyRestriction: 'yes' },
                  })}
                  onClick={() => permissionAction({ copyRestriction: 'yes' })}
                >
                  复制与下载限制
                </Button>
              </div>
              {topAction('share', '高级组合设置', <Share2 size={14} />)}
            </section>
            <p className="console-section-label">所有权</p>
            {topAction('transfer', '转让所有权', <MoveRight size={16} />)}
            <p className="console-section-label">文件操作</p>
            <Button
              disabled={!selected.size || busy}
              onClick={() =>
                run(async () => {
                  await api.copyLinks(chosen.map(fileLink));
                  notify('已复制 ' + chosen.length + ' 个链接');
                })
              }
            >
              <Link size={16} />
              复制链接
            </Button>
            <div className="action-grid">
              {topAction('rename', '重命名', <FileText size={14} />, selected.size !== 1)}
              {topAction('move', '移动', <Folder size={14} />)}
              {topAction(
                'copy',
                '副本',
                <Copy size={14} />,
                !selected.size || chosen.some((f) => f.mimeType === FOLDER),
              )}
              <Button
                danger
                disabled={busy || !!operationProblem(trashView ? 'restore' : 'trash')}
                title={operationProblem(trashView ? 'restore' : 'trash')}
                onClick={() => begin(trashView ? 'restore' : 'trash')}
              >
                <Trash2 size={14} />
                {trashView ? '恢复' : '删除'}
              </Button>
            </div>
            <details className="more-file-tools">
              <summary>更多文件操作</summary>
              <Button
                title={operationProblem('mkdir')}
                disabled={busy || !!operationProblem('mkdir')}
                onClick={() => begin('mkdir')}
              >
                <FolderPlus size={16} />
                新建文件夹
              </Button>
              <Button
                disabled={!accountId || busy}
                onClick={() => {
                  setInput('');
                  setModal('import');
                }}
              >
                <Plus size={16} />
                导入文件链接
              </Button>
              <Button
                disabled={!files.length || busy}
                onClick={() =>
                  run(async () =>
                    notify(
                      await api.exportSnapshot(
                        accountId,
                        files,
                        snapshot?.complete ?? false,
                        snapshot?.rootId,
                        snapshot?.maxDepth,
                      ),
                    ),
                  )
                }
              >
                <Download size={16} />
                导出本次目录
              </Button>
            </details>
          </div>
          {selected.size > 0 && (
            <button className="text-tool clear-selection" onClick={() => setSelected(new Set())}>
              清空选择
            </button>
          )}
          {single && (
            <section className="console-file">
              <strong title={single.name}>{single.name}</strong>
              <p>
                {typeLabel(single)} · {sizeText(single)}
              </p>
              <details className="file-metadata">
                <summary>文件详情</summary>
                <p>{quotaSizeLabel(directory.sizes.get(single.id)!)}</p>
                <p>
                  创建 {dateLabel(single.createdTime)} · 修改 {dateLabel(single.modifiedTime)}
                </p>
                <p title={directoryPath(single.id, directory)}>
                  {directoryPath(single.id, directory)}
                </p>
                {single.mimeType === FOLDER && (
                  <p>
                    {directory.sizes.get(single.id)!.files} 个后代文件 ·{' '}
                    {directory.sizes.get(single.id)!.folders} 个子文件夹
                  </p>
                )}
                <p title={single.owners?.[0]?.emailAddress}>
                  {single.owners?.[0]?.emailAddress || '所有者未知'}
                </p>
                <code>{single.id}</code>
              </details>
              <Button disabled={permissionBusy || busy} onClick={readPermissions}>
                {permissionBusy
                  ? '读取中…'
                  : single.permissions === undefined
                    ? '读取访问权限'
                    : '刷新访问权限'}
              </Button>
              {permError && <small className="error-text">{permError}</small>}
              <div className="console-permissions">
                {permissions.map((p) => (
                  <div className="console-permission" key={p.id}>
                    <span>
                      {p.type === 'anyone' ? '任何人链接' : p.emailAddress || p.domain || p.type}
                    </span>
                    <small>
                      {p.pendingOwner ? '待接收所有权' : roles[p.role] || p.role}
                      {p.permissionDetails?.some((d) => d.inherited) ? ' · 继承' : ''}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <div className="console-tasks">
          <Button onClick={() => setPage('tasks')}>
            <ListChecks size={16} />
            任务记录{totalTasks ? ' · ' + totalTasks + ' 进行中' : ''}
          </Button>
          {boot.tasks
            .filter(
              (t) => t.status === 'running' || t.status === 'paused' || t.status === 'partial',
            )
            .slice(0, 3)
            .map((t) => (
              <button
                className="task-mini"
                key={t.id}
                onClick={() => run(async () => setTaskDetail(await api.task(t.id)))}
              >
                <span>{t.title}</span>
                <small>
                  {states[t.status]} · {t.succeeded || 0}/{t.total || 0}
                </small>
              </button>
            ))}
        </div>
      </aside>
      {page === 'tasks' && (
        <Modal wide title="任务记录" onClose={() => setPage('files')}>
          {!!boot.tasks.length && (
            <div className="record-toolbar">
              <span className="form-hint">清理仅删除本机记录，不撤销已完成的网盘操作。</span>
              <Button
                disabled={
                  busy ||
                  !boot.tasks.some((t) => t.status === 'completed' || t.status === 'partial')
                }
                onClick={() =>
                  setCleanup({
                    kind: 'tasks',
                    ids: boot.tasks
                      .filter((t) => t.status === 'completed' || t.status === 'partial')
                      .map((t) => t.id),
                  })
                }
              >
                <Trash2 size={14} />
                清理已结束任务
              </Button>
            </div>
          )}
          <div className="task-list">
            {!boot.tasks.length && (
              <div className="empty-state">
                <ListChecks size={44} />
                <h3>所有操作，从这里有序完成</h3>
                <p>在文件列表选择项目，然后配置分享或转让所有权。</p>
                <Button onClick={() => setPage('files')}>
                  返回文件管理 <ArrowRight size={15} />
                </Button>
              </div>
            )}
            {boot.tasks.map((t) => {
              const done = t.succeeded ?? t.items.filter((i) => i.state === 'succeeded').length;
              const count = t.total ?? t.items.length;
              const skipped = t.skipped ?? t.items.filter((i) => i.state === 'skipped').length;
              const finishedWithSkips = skipped > 0 && done + skipped === count;
              return (
                <article className="task-card" key={t.id}>
                  <div className="task-icon">
                    {t.request.kind === 'transfer' ? (
                      <MoveRight size={21} />
                    ) : t.request.kind === 'share' ? (
                      <Share2 size={21} />
                    ) : (
                      <Folder size={21} />
                    )}
                  </div>
                  <div className="task-main">
                    <div className="task-title">
                      <h3>{t.title}</h3>
                      <Badge
                        tone={
                          t.status === 'completed'
                            ? 'green'
                            : t.status === 'paused' || t.status === 'partial'
                              ? 'amber'
                              : 'violet'
                        }
                      >
                        {finishedWithSkips ? '已完成（有跳过）' : states[t.status]}
                      </Badge>
                    </div>
                    <p>
                      {boot.accounts.find((a) => a.id === t.request.accountId)?.email}
                      {t.request.targetAccountId && (
                        <>
                          {' '}
                          → {boot.accounts.find((a) => a.id === t.request.targetAccountId)?.email}
                        </>
                      )}
                    </p>
                    {t.api && (
                      <p>
                        API 读取 {t.api.reads} · 写入 {t.api.writes} · 重试/复查 {t.api.retries} ·
                        限流 {t.api.rateLimits}
                      </p>
                    )}
                    <div className="progress-track">
                      <span
                        style={{ width: `${((done + skipped) / Math.max(count, 1)) * 100}%` }}
                      />
                    </div>
                    <div className="task-count">
                      <span>
                        {done} / {count} 项已验证{skipped > 0 && ` · ${skipped} 项已跳过`}
                      </span>
                      <span>{new Date(t.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                  </div>
                  <div className="task-buttons">
                    <Button onClick={() => run(async () => setTaskDetail(await api.task(t.id)))}>
                      查看明细
                    </Button>
                    {['running', 'queued'].includes(t.status) ? (
                      <Button
                        onClick={() =>
                          run(async () => {
                            await api.control(t.id, 'pause');
                            await refresh();
                          })
                        }
                      >
                        <Pause size={14} />
                        暂停
                      </Button>
                    ) : (
                      t.status !== 'completed' &&
                      !finishedWithSkips && (
                        <Button
                          onClick={() =>
                            run(async () => {
                              await api.control(t.id, 'retry');
                              await refresh();
                            })
                          }
                        >
                          <Play size={14} />
                          继续 / 对账
                        </Button>
                      )
                    )}
                    <button
                      className="icon-button"
                      title="导出任务报告"
                      onClick={() => run(async () => notify(await api.exportReport(t.id)))}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="删除本地任务记录"
                      disabled={busy || ['running', 'queued'].includes(t.status)}
                      onClick={() => setCleanup({ kind: 'tasks', ids: [t.id] })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </Modal>
      )}
      {marquee.rect && <div className="marquee" style={marquee.rect} />}
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={17} />
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.file.mimeType === FOLDER && (
            <button onClick={() => navigate(menu.file.id, menu.file.name)}>
              <Folder size={15} />
              打开文件夹
            </button>
          )}
          <button
            onClick={() =>
              run(async () => {
                await api.copyLinks([fileLink(menu.file)]);
                notify('已复制链接');
              })
            }
          >
            <Link size={15} />
            复制链接
          </button>
          <button
            disabled={busy || !!operationProblem('share', [menu.file])}
            title={operationProblem('share', [menu.file])}
            onClick={() => begin('share', menu.file)}
          >
            <Share2 size={15} />
            分享设置
          </button>
          <button
            disabled={busy || !!operationProblem('transfer', [menu.file])}
            title={operationProblem('transfer', [menu.file])}
            onClick={() => begin('transfer', menu.file)}
          >
            <MoveRight size={15} />
            转让所有权
          </button>
          <button
            disabled={busy || !!operationProblem('rename', [menu.file])}
            title={operationProblem('rename', [menu.file])}
            onClick={() => begin('rename', menu.file)}
          >
            <FileText size={15} />
            重命名
          </button>
          <button
            disabled={busy || !!operationProblem('move', [menu.file])}
            title={operationProblem('move', [menu.file])}
            onClick={() => begin('move', menu.file)}
          >
            <Folder size={15} />
            移动到…
          </button>
          {menu.file.mimeType !== FOLDER && (
            <button
              disabled={busy || !!operationProblem('copy', [menu.file])}
              title={operationProblem('copy', [menu.file])}
              onClick={() => begin('copy', menu.file)}
            >
              <Copy size={15} />
              创建副本
            </button>
          )}
          <hr />
          <button
            className="error-text"
            disabled={busy || !!operationProblem(trashView ? 'restore' : 'trash', [menu.file])}
            title={operationProblem(trashView ? 'restore' : 'trash', [menu.file])}
            onClick={() => begin(trashView ? 'restore' : 'trash', menu.file)}
          >
            <Trash2 size={15} />
            {trashView ? '从回收站恢复' : '移入回收站'}
          </button>
        </div>
      )}

      {action && (
        <Modal
          wide
          title={plan ? '确认操作计划' : action === 'share' ? shareActionTitle : TITLES[action]}
          subtitle={`${boot.mode === 'demo' ? '演示数据 · ' : ''}执行账号：${account?.email || ''}`}
          onClose={() => {
            if (!busy) {
              setAction(null);
              setPlan(null);
            }
          }}
        >
          {plan ? (
            <>
              <div className="plan-summary">
                <Badge tone="green">
                  {plan.items.filter((i) => !i.blocked && !i.skipReason).length} 项可执行
                </Badge>
                {plan.items.some((i) => i.blocked) && (
                  <Badge tone="amber">{plan.items.filter((i) => i.blocked).length} 项被阻止</Badge>
                )}
                {plan.items.some((i) => i.skipReason) && (
                  <Badge tone="amber">
                    {plan.items.filter((i) => i.skipReason).length} 项将跳过
                  </Badge>
                )}
                <span>计划已冻结 · 同一文件串行执行</span>
              </div>
              {!!plan.ownershipNotice?.foreign && (
                <div className="notice amber" role="alert">
                  <AlertCircle size={18} />
                  <p>
                    <strong>
                      当前文件夹中有 {plan.ownershipNotice.foreign} 个项目的所有者不是你。
                    </strong>
                    这些项目不会转让所有权；其余可转让项目会继续处理。跳过项保留原所有者，移动父文件夹仍可能改变继承访问，目标账号不一定能访问。下方已列出本次处理和跳过的项目，请确认后执行。
                  </p>
                </div>
              )}
              {!!plan.ownershipNotice?.unknown && (
                <p className="plan-warning" role="alert">
                  另有 {plan.ownershipNotice.unknown} 个项目无法确认所有者，请查看下方检查结果。
                </p>
              )}
              {plan.warnings.map((warning, i) => (
                <p className="plan-warning" key={i}>
                  {warning}
                </p>
              ))}
              <div className="plan-list">
                {plan.items.map((i) => (
                  <div
                    key={i.file.id}
                    className={`plan-row ${i.blocked || i.skipReason ? 'blocked' : ''}`}
                  >
                    <IconFile file={i.file} />
                    <div>
                      <strong>{i.file.name}</strong>
                      {action === 'transfer' && i.skipReason && (
                        <p>
                          当前所有者：
                          {i.file.owners
                            ?.map((o) => o.emailAddress || o.displayName)
                            .filter(Boolean)
                            .join('、') || '未提供'}
                        </p>
                      )}
                      <p>
                        {i.blocked ||
                          i.skipReason ||
                          i.changes.join('；') ||
                          '当前设置已满足，无需变更'}
                      </p>
                    </div>
                    {i.blocked || i.skipReason ? <AlertCircle size={17} /> : <Check size={17} />}
                  </div>
                ))}
              </div>
              <div className="notice">
                <ShieldCheck size={18} />
                <p>
                  {action === 'transfer'
                    ? '自动接收仅处理本次任务中的文件；所有权成功验证后才执行可选的原账号权限移除。'
                    : '执行前会重新检查关键状态。失败或结果未知的项目会保留，可单独重试和对账。'}
                  {plan.items.some((i) => i.blocked) && ' 被阻止的项目不会执行。'}
                </p>
              </div>
              <footer className="modal-footer">
                <Button disabled={busy} onClick={() => setPlan(null)}>
                  <ArrowLeft size={15} />
                  返回设置
                </Button>
                <Button
                  primary
                  disabled={busy || plan.items.every((i) => i.blocked || i.skipReason)}
                  onClick={submit}
                >
                  {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认执行{' '}
                  {plan.items.filter((i) => !i.blocked && !i.skipReason).length} 项
                </Button>
              </footer>
            </>
          ) : (
            <>
              <div className="modal-body">
                <div className="scope-card">
                  <ListChecks size={20} />
                  <div>
                    <strong>
                      {action === 'mkdir' ? '创建一个新文件夹' : `已选择 ${selected.size} 个项目`}
                    </strong>
                    <small>
                      所有者范围：
                      {ownerFilter === 'mine'
                        ? '仅我拥有'
                        : ownerFilter === 'others'
                          ? '仅他人拥有'
                          : ownerFilter === 'unknown'
                            ? '所有者未知'
                            : '全部'}{' '}
                      · 下一步先检查具体变更，不会立即执行
                    </small>
                  </div>
                </div>
                {action === 'share' && simpleShare && (
                  <section className="form-section simple-permission-form">
                    {share.collaborators !== 'keep' ? (
                      <>
                        <label className="field">
                          {share.collaborators === 'remove'
                            ? '要移除的邮箱'
                            : share.collaborators === 'replace'
                              ? '替换后的完整邮箱名单'
                              : '邮箱列表'}
                          <textarea
                            aria-label="协作者列表"
                            autoFocus
                            rows={4}
                            value={peopleText}
                            onChange={(e) => setPeopleText(e.target.value)}
                            placeholder="粘贴多个邮箱，换行、空格、逗号或分号均可"
                          />
                        </label>
                        {share.collaborators !== 'remove' && (
                          <label className="field">
                            目标权限角色
                            <select
                              value={personRole}
                              onChange={(e) =>
                                setPersonRole(e.target.value as Collaborator['role'])
                              }
                            >
                              <option value="writer">编辑者 · 可以修改文件</option>
                              <option value="commenter">评论者 · 可以查看和评论</option>
                              <option value="reader">查看者 · 只读</option>
                            </select>
                          </label>
                        )}
                        {share.collaborators === 'add' && (
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={share.notify}
                              onChange={(e) => setShare({ ...share, notify: e.target.checked })}
                            />
                            发送授权通知邮件
                          </label>
                        )}
                        <p className="operation-explanation">
                          {share.collaborators === 'add'
                            ? '这些邮箱将获得所选角色；已有授权的邮箱也会调整到该角色。其他邮箱和链接分享保持现状。'
                            : share.collaborators === 'update'
                              ? '只修改这些邮箱已有的角色；没有权限的邮箱不会被新增。其他邮箱和链接分享保持现状。'
                              : share.collaborators === 'remove'
                                ? '只移除这些邮箱的直接授权，保留其他协作者、所有者和链接分享。继承的权限会在预览中说明。'
                                : '先添加并验证以上名单，再移除名单外的直接用户协作者。所有者、群组、域和链接分享保留。'}
                        </p>
                      </>
                    ) : share.public !== 'keep' ? (
                      <>
                        {share.public !== 'off' && (
                          <label className="field">
                            获得链接的人可以
                            <select
                              value={share.public}
                              onChange={(e) =>
                                setShare({
                                  ...share,
                                  public: e.target.value as ShareConfig['public'],
                                })
                              }
                            >
                              <option value="reader">查看</option>
                              <option value="commenter">评论</option>
                              <option value="writer">编辑</option>
                            </select>
                          </label>
                        )}
                        <p className="operation-explanation">
                          {share.public === 'off'
                            ? '将移除所选文件的“任何人链接访问”，邮箱、群组、域共享保持现状。关闭后仍可能有其他授权。'
                            : '开启任何人链接访问，邮箱、群组和域共享保持现状。'}
                        </p>
                      </>
                    ) : share.writersCanShare !== 'keep' ? (
                      <>
                        <label className="field">
                          编辑者再次分享
                          <select
                            value={share.writersCanShare}
                            disabled={
                              !!operationProblem('share', chosen, {
                                ...DEFAULT_SHARE,
                                writersCanShare: 'no',
                              })
                            }
                            title={operationProblem('share', chosen, {
                              ...DEFAULT_SHARE,
                              writersCanShare: 'no',
                            })}
                            onChange={(e) =>
                              setShare({
                                ...share,
                                writersCanShare: e.target.value as ShareConfig['writersCanShare'],
                              })
                            }
                          >
                            <option value="no">限制 · 仅所有者管理分享</option>
                            <option value="yes">允许编辑者再次分享</option>
                          </select>
                        </label>
                        <p className="operation-explanation">
                          只调整再次分享设置，已有协作者和链接访问保持现状。
                        </p>
                      </>
                    ) : share.copyRestriction !== 'keep' ? (
                      <>
                        <label className="field">
                          查看者与评论者复制、下载、打印
                          <select
                            value={share.copyRestriction}
                            disabled={
                              !!operationProblem('share', chosen, {
                                ...DEFAULT_SHARE,
                                copyRestriction: 'yes',
                              })
                            }
                            title={operationProblem('share', chosen, {
                              ...DEFAULT_SHARE,
                              copyRestriction: 'yes',
                            })}
                            onChange={(e) =>
                              setShare({
                                ...share,
                                copyRestriction: e.target.value as ShareConfig['copyRestriction'],
                              })
                            }
                          >
                            <option value="yes">限制</option>
                            <option value="no">允许</option>
                          </select>
                        </label>
                        <p className="operation-explanation">
                          只调整这项限制；不移除任何协作者，对编辑者不提供此项限制。
                        </p>
                      </>
                    ) : (
                      <p className="operation-explanation">
                        将移除所选文件的直接{share.removeGroups ? '群组' : '域'}
                        共享；用户邮箱、所有者和任何人链接访问保持现状。继承权限不会自动向父目录扩大处理。
                      </p>
                    )}
                    <p className="form-hint">下一步会逐文件列出变更，确认后才执行。</p>
                  </section>
                )}
                {action === 'share' && !simpleShare && (
                  <>
                    <div className="form-section">
                      <h3>链接与协作者</h3>
                      <label className="field">
                        任何人链接访问
                        <select
                          value={share.public}
                          onChange={(e) =>
                            setShare({ ...share, public: e.target.value as ShareConfig['public'] })
                          }
                        >
                          <option value="keep">保持现状</option>
                          <option value="off">关闭任何人链接访问</option>
                          <option value="reader">开启 · 查看者</option>
                          <option value="commenter">开启 · 评论者</option>
                          <option value="writer">开启 · 编辑者</option>
                        </select>
                      </label>
                      <label className="field">
                        协作者处理
                        <select
                          value={share.collaborators}
                          onChange={(e) =>
                            setShare({
                              ...share,
                              collaborators: e.target.value as ShareConfig['collaborators'],
                            })
                          }
                        >
                          <option value="keep">保持现状</option>
                          <option value="add">添加或调整指定协作者</option>
                          <option value="update">只修改已有协作者角色 · 不新增</option>
                          <option value="replace">替换直接用户协作者 · 保留所有者</option>
                          <option value="remove">移除指定协作者</option>
                        </select>
                      </label>
                      <p className="permission-scope-hint">
                        {share.collaborators === 'add'
                          ? '多个邮箱将应用到每个所选文件；已存在的邮箱按下方角色调整。'
                          : share.collaborators === 'update'
                            ? '只调整指定邮箱已有的权限；未获授权的邮箱不会新增。'
                            : share.collaborators === 'remove'
                              ? '只移除输入的邮箱或主体；其他协作者和所有者保留。'
                              : share.collaborators === 'replace'
                                ? '先添加并验证名单中的邮箱，再移除名单以外的直接用户协作者。'
                                : '链接访问、用户、群组、域共享和分享限制分别设置；保持现状的项目不会修改。'}
                      </p>
                      {share.collaborators === 'replace' && (
                        <label className="check-label error-text">
                          <input
                            type="checkbox"
                            checked={!!share.clearUsers}
                            onChange={(e) => setShare({ ...share, clearUsers: e.target.checked })}
                          />
                          清空全部直接用户协作者（保留所有者，不删除群组或域）
                        </label>
                      )}
                      {share.collaborators !== 'keep' && !share.clearUsers && (
                        <>
                          <div className="form-row">
                            <label className="field">
                              主体类型
                              <select
                                value={personType}
                                onChange={(e) =>
                                  setPersonType(e.target.value as Collaborator['type'])
                                }
                              >
                                <option value="user">用户邮箱</option>
                                <option value="group">Google 群组</option>
                                <option value="domain">域名</option>
                              </select>
                            </label>
                            {share.collaborators !== 'remove' && (
                              <label className="field">
                                权限角色
                                <select
                                  value={personRole}
                                  onChange={(e) =>
                                    setPersonRole(e.target.value as Collaborator['role'])
                                  }
                                >
                                  <option value="writer">编辑者</option>
                                  <option value="commenter">评论者</option>
                                  <option value="reader">查看者</option>
                                </select>
                              </label>
                            )}
                          </div>
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={mapping}
                              onChange={(e) => setMapping(e.target.checked)}
                            />
                            逐行映射文件与邮箱（不勾选时应用到全部所选文件）
                          </label>
                          <textarea
                            aria-label="协作者列表"
                            rows={4}
                            value={peopleText}
                            onChange={(e) => setPeopleText(e.target.value)}
                            placeholder={
                              mapping
                                ? '每行：文件链接,邮箱,writer 或 reader 或 commenter'
                                : '输入邮箱，用换行、逗号或分号分隔'
                            }
                          />
                          {share.collaborators !== 'remove' && (
                            <label className="check-label">
                              <input
                                type="checkbox"
                                checked={share.atLeast}
                                onChange={(e) => setShare({ ...share, atLeast: e.target.checked })}
                              />
                              至少权限模式：已有更高角色不降级
                            </label>
                          )}
                          {['add', 'replace'].includes(share.collaborators) && (
                            <label className="check-label">
                              <input
                                type="checkbox"
                                checked={share.notify}
                                onChange={(e) => setShare({ ...share, notify: e.target.checked })}
                              />
                              新增普通授权时发送通知邮件
                            </label>
                          )}
                        </>
                      )}
                    </div>
                    <div className="form-section">
                      <h3>
                        其他分享设置 <small>每一项独立设置</small>
                      </h3>
                      <div className="form-row">
                        <label className="field">
                          编辑者再次分享
                          <select
                            value={share.writersCanShare}
                            onChange={(e) =>
                              setShare({
                                ...share,
                                writersCanShare: e.target.value as ShareConfig['writersCanShare'],
                              })
                            }
                          >
                            <option value="keep">保持现状</option>
                            <option value="yes">允许</option>
                            <option value="no">限制</option>
                          </select>
                        </label>
                        <label className="field">
                          查看者复制 / 下载 / 打印
                          <select
                            value={share.copyRestriction}
                            onChange={(e) =>
                              setShare({
                                ...share,
                                copyRestriction: e.target.value as ShareConfig['copyRestriction'],
                              })
                            }
                          >
                            <option value="keep">保持现状</option>
                            <option value="yes">限制</option>
                            <option value="no">允许</option>
                          </select>
                        </label>
                      </div>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={share.removeGroups}
                          onChange={(e) => setShare({ ...share, removeGroups: e.target.checked })}
                        />
                        移除直接群组共享
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={share.removeDomains}
                          onChange={(e) => setShare({ ...share, removeDomains: e.target.checked })}
                        />
                        移除直接域共享
                      </label>
                    </div>
                  </>
                )}
                {action === 'transfer' && (
                  <div className="form-section">
                    <h3>交接给另一个账号</h3>
                    <label className="field">
                      目标账号
                      <select
                        aria-label="目标账号"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                      >
                        <option value="">请选择已连接的 Gmail</option>
                        {boot.accounts
                          .filter((a) => a.id !== accountId)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} · {a.email}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="transfer-flow">
                      <span>
                        <KeyRound size={16} />
                        源账号发起
                      </span>
                      <ArrowRight size={15} />
                      <span>
                        <CheckCheck size={16} />
                        目标自动接收
                      </span>
                      <ArrowRight size={15} />
                      <span>
                        <ShieldCheck size={16} />
                        复核所有者
                      </span>
                    </div>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={removeSource}
                        onChange={(e) => setRemoveSource(e.target.checked)}
                      />
                      成功验证后移除原账号访问权（默认保留编辑权限）
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={moveToTargetRoot}
                        onChange={(e) => setMoveToTargetRoot(e.target.checked)}
                      />
                      转让后移到目标账号的“我的云端硬盘”根目录
                    </label>
                    {recursive && (
                      <p className="form-hint">
                        尽量完成：自动跳过明确不可转让的子项，父文件夹必须转让成功。跳过项保留原所有者，不清理其权限；目录移动可能改变继承访问，目标账号不一定能访问这些文件。网络超时或结果未知仍暂停对账。
                      </p>
                    )}
                    {moveToTargetRoot && (
                      <div className="notice amber">
                        <Folder size={18} />
                        <p>
                          将移出原父文件夹，原父目录的继承授权会随位置变化。递归转让保留内部层级，仅移动所选顶层项目；直接授权仍会保留，勾选上方移除选项才清理原账号直接访问。
                        </p>
                      </div>
                    )}
                    <p className="form-hint">
                      个人 Gmail 间按 Google 的发起与接收流程执行，可能收到系统通知邮件。
                    </p>
                  </div>
                )}
                {['rename', 'mkdir'].includes(action) && (
                  <label className="field">
                    {action === 'mkdir' ? '文件夹名称' : '新名称'}
                    <input
                      aria-label="名称"
                      autoFocus
                      maxLength={255}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="输入名称"
                    />
                  </label>
                )}
                {['move', 'copy', 'mkdir'].includes(action) && (
                  <label className="field">
                    目标文件夹链接或 ID
                    <input
                      aria-label="目标文件夹"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder="root 表示根目录"
                    />
                    <small>同一账号内操作；不会按同名自动覆盖。</small>
                  </label>
                )}
                {action === 'trash' && (
                  <div className="notice amber">
                    <Trash2 size={19} />
                    <p>所选项目将移入回收站，不会永久删除。所选父目录已包含的后代会去重处理。</p>
                  </div>
                )}
                {action === 'restore' && (
                  <div className="notice">
                    <RotateCcw size={19} />
                    <p>恢复所选项目。原目录状态和访问能力将在执行时再次检查。</p>
                  </div>
                )}
                {['share', 'transfer'].includes(action) &&
                  chosen.some((f) => f.mimeType === FOLDER) && (
                    <div className="form-section">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={recursive}
                          onChange={(e) => setRecursive(e.target.checked)}
                        />
                        包含文件夹内后代（仍按当前所有者范围筛选）
                      </label>
                      <p className="form-hint">
                        继承授权不会自动从父目录移除，也不会自动移动文件。需要改父目录时，请明确选中父目录另建任务。
                      </p>
                    </div>
                  )}
              </div>
              <footer className="modal-footer">
                <Button disabled={busy} onClick={() => setAction(null)}>
                  取消
                </Button>
                <Button
                  primary
                  disabled={
                    busy ||
                    (action === 'share' &&
                      simpleShare &&
                      share.collaborators !== 'keep' &&
                      !peopleText.trim())
                  }
                  onClick={preview}
                >
                  {busy ? <LoaderCircle className="spin" size={16} /> : <ListChecks size={16} />}
                  生成变更预览
                </Button>
              </footer>
            </>
          )}
        </Modal>
      )}
      {modal === 'connections' && (
        <Modal
          title="账号与授权连接"
          subtitle="每个账号独立管理，可为同一 Gmail 添加多个客户端授权。"
          onClose={() => setModal(null)}
          wide
        >
          <div className="modal-body">
            <div className="connection-heading">
              <Badge tone={boot.mode === 'demo' ? 'amber' : 'green'}>
                {boot.demoEnabled
                  ? boot.mode === 'demo'
                    ? '当前是演示模式'
                    : '当前是真实账号模式'
                  : 'Google Drive 授权连接'}
              </Badge>
              {boot.demoEnabled && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.switchMode(boot.mode === 'demo' ? 'live' : 'demo');
                      await refresh();
                      setCrumbs([{ id: 'root', name: folderNames.root }]);
                    })
                  }
                >
                  切换至{boot.mode === 'demo' ? '真实' : '演示'}模式
                </Button>
              )}
            </div>
            {boot.mode === 'live' && boot.connections.some((c) => !c.ready) && (
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const pending = boot.connections.filter((c) => !c.ready);
                    const failed: string[] = [];
                    for (let i = 0; i < pending.length; i++) {
                      notify(
                        '正在授权 ' + (i + 1) + '/' + pending.length + '，请在浏览器选择对应 Gmail',
                      );
                      try {
                        await api.authorize(pending[i].id);
                      } catch (e) {
                        failed.push(e instanceof Error ? e.message : String(e));
                      }
                      await refresh();
                    }
                    notify(
                      '授权完成 ' +
                        (pending.length - failed.length) +
                        '/' +
                        pending.length +
                        (failed.length ? '；失败：' + failed.join('；') : ''),
                    );
                  })
                }
              >
                <KeyRound size={15} />
                依次授权未连接项
              </Button>
            )}
            {boot.connections.map((c) => (
              <div className="connection-row" key={c.id}>
                <span className="overview-icon green">
                  <KeyRound size={18} />
                </span>
                <div>
                  <strong>
                    {boot.accounts.find((a) => a.id === c.accountId)?.email || '尚未绑定 Gmail'}
                  </strong>
                  <code title={c.clientId}>{c.clientId}</code>
                  {c.error && <small className="error-text">{c.error}</small>}
                </div>
                <Badge tone={c.ready ? 'green' : 'amber'}>{c.ready ? '已连接' : '待授权'}</Badge>
                {boot.mode === 'live' && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          notify('已打开系统浏览器，请在3分钟内完成登录。');
                          notify(await api.authorize(c.id));
                          await refresh();
                        })
                      }
                    >
                      {c.ready ? '再次授权' : '浏览器授权'}
                    </Button>
                    <button
                      className="icon-button"
                      title="移除本地授权连接"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api.disconnect(c.id);
                          await refresh();
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {!boot.connections.length && (
              <div className="empty-state">
                <KeyRound size={35} />
                <h3>连接 Google Drive</h3>
                <p>导入 Desktop app 类型的 credentials.json，或已有 token.json。</p>
              </div>
            )}
            <div className="notice">
              <ShieldCheck size={18} />
              <p>
                真实令牌使用系统加密保存在本机。每个连接先验证 Gmail
                身份，再加入对应账号的并发池。再次授权可添加其他 Gmail；同账号同客户端会更新原连接。
              </p>
            </div>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setModal(null)}>关闭</Button>
            <Button disabled={busy} onClick={() => setModal('data')}>
              管理账号与数据
            </Button>
            <Button
              primary
              disabled={busy}
              onClick={() =>
                run(async () => {
                  notify(await api.importCredentials());
                  await refresh();
                })
              }
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}导入授权文件
            </Button>
          </footer>
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal
          title="并发与执行设置"
          subtitle="全局不限业务并发；每账号最高 18，每授权连接最高 6。"
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <div className="update-panel">
              <strong>软件更新 · {boot.update?.current || '开发版本'}</strong>
              <p className="form-hint">
                启动后自动检查并下载更新；准备好后由你确认重启，不中断正在执行的任务。
              </p>
              <p className="form-hint">
                {boot.update?.status === 'downloading'
                  ? `正在下载 ${boot.update.latest}${boot.update.percent !== undefined ? ` · ${boot.update.percent}%` : ''}`
                  : boot.update?.status === 'ready'
                    ? `新版本 ${boot.update.latest} 已下载并通过校验`
                    : boot.update?.status === 'checking'
                      ? '正在检查更新…'
                      : boot.update?.status === 'unsupported'
                        ? '开发与本地测试目录不自动更新，请使用正式便携版'
                        : boot.update?.error || '可检查 GitHub 上的最新稳定版本'}
              </p>
              <Button
                disabled={
                  busy ||
                  ['checking', 'downloading', 'installing', 'unsupported'].includes(
                    boot.update?.status || 'unsupported',
                  )
                }
                onClick={() =>
                  boot.update?.status === 'ready'
                    ? setUpdateConfirm(true)
                    : run(async () => {
                        await api.checkUpdate();
                        const b = await refresh();
                        if (b?.update?.status === 'idle') notify('当前已是最新版本');
                      })
                }
              >
                <RefreshCw size={14} />
                {boot.update?.status === 'ready' ? '重启并更新' : '检查更新'}
              </Button>
            </div>
            {(
              [
                ['accountConcurrency', '每账号并发上限', 18],
                ['connectionConcurrency', '每授权连接并发上限', 6],
              ] as const
            ).map(([key, label, max]) => (
              <label className="field" key={key}>
                {label}
                <input
                  type="number"
                  min={1}
                  max={max}
                  value={draftSettings[key]}
                  onChange={(e) =>
                    setDraftSettings({ ...draftSettings, [key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
            {boot.runtime?.accounts.map((item) => (
              <p className="form-hint" key={item.accountId}>
                {boot.accounts.find((a) => a.id === item.accountId)?.email || '账号'}：当前并发{' '}
                {item.active}/{item.limit}，可用上限 {item.ceiling}，近一分钟{' '}
                {item.requestsPerMinute} 次请求
                {item.waitingMs > 0 && ` · 冷却剩余 ${Math.ceil(item.waitingMs / 1000)} 秒`}
                {item.reason && ` · ${item.reason}`}
              </p>
            ))}
            {boot.runtime?.projects
              .filter((group) => group.waitingMs > 0 || group.limit < group.ceiling)
              .map((group) => (
                <p className="form-hint" key={group.project}>
                  {group.project === 'unidentified'
                    ? '项目未识别的连接组'
                    : `项目 ${group.project}`}
                  ：共享并发 {group.active}/{group.limit}
                  {group.waitingMs > 0 && ` · 冷却剩余 ${Math.ceil(group.waitingMs / 1000)} 秒`}
                  {group.reason && ` · ${group.reason}`}
                </p>
              ))}
            <div className="notice">
              <Zap size={18} />
              <p>
                开始即按可用上限执行。限流后对应账号或项目统一减半并等待，同一轮只降一次；稳定 60
                秒后逐级恢复。相同文件的修改保持串行。
              </p>
            </div>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button
              primary
              onClick={() =>
                run(async () => {
                  await api.settings(draftSettings);
                  await refresh();
                  setModal(null);
                  notify('执行设置已保存');
                })
              }
            >
              保存设置
            </Button>
          </footer>
          <div className="data-settings-entry">
            <Button onClick={() => setModal('data')}>
              数据与记录管理 <ArrowRight size={14} />
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'data' && (
        <Modal
          title="数据与记录管理"
          subtitle="仅管理本机数据，不删除 Google Drive 文件。"
          onClose={() => setModal(null)}
        >
          <div className="modal-body data-management">
            <div className="data-action-row">
              <div>
                <strong>扫描结果</strong>
                <p>清空所有账号本次扫描的目录和选择，不影响任务记录。</p>
              </div>
              <Button
                disabled={loading || busy}
                onClick={() => {
                  clearScans(true);
                  notify('已清空全部本地扫描结果');
                }}
              >
                清空扫描结果
              </Button>
            </div>
            <div className="data-action-row">
              <div>
                <strong>账号头像</strong>
                <p>缓存一天，过期后在下次启动时更新，也可手动刷新。</p>
              </div>
              <Button
                disabled={busy || boot.mode !== 'live' || !boot.accounts.length}
                onClick={() =>
                  run(async () => {
                    notify(await api.refreshAvatars());
                    await refresh();
                  })
                }
              >
                刷新账号头像
              </Button>
            </div>
            <div>
              <strong>已保存账号</strong>
              <p className="form-hint">
                移除账号同时删除本地授权和头像，保留历史任务；不会撤销 Google 端授权。
              </p>
              {boot.accounts.map((a) => (
                <div className="data-action-row" key={a.id}>
                  <AccountAvatar account={a} />
                  <span className="data-account-email">{a.email}</span>
                  <Button
                    danger
                    disabled={busy || loading}
                    onClick={() => setCleanup({ kind: 'account', account: a })}
                  >
                    移除账号
                  </Button>
                </div>
              ))}
              {!boot.accounts.length && <p className="form-hint">暂无本地账号</p>}
            </div>
            <div className="data-action-row reset-data">
              <div>
                <strong>重置本地数据</strong>
                <p>清空账号、授权、头像、任务明细和日志、扫描结果及应用设置。已导出的文件保留。</p>
              </div>
              <Button
                danger
                disabled={busy || loading}
                onClick={() => {
                  setResetText('');
                  setCleanup({ kind: 'reset' });
                }}
              >
                重置本地数据
              </Button>
            </div>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setModal(null)}>关闭</Button>
          </footer>
        </Modal>
      )}
      {modal === 'import' && (
        <Modal
          title="导入文件链接"
          subtitle="每行一个 Google Drive / Docs 链接或文件 ID，自动去重。"
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <textarea
              aria-label="文件链接列表"
              rows={9}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…\nhttps://docs.google.com/spreadsheets/d/…"
            />
            <p className="form-hint">使用当前账号验证可访问性。导入后可继续批量配置分享或转让。</p>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button primary disabled={busy || !input.trim()} onClick={importLinks}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <Link size={16} />}验证并导入
            </Button>
          </footer>
        </Modal>
      )}
      {taskDetail && (
        <Modal
          wide
          title={`${taskDetail.title} · 执行明细`}
          subtitle={`任务 ${taskDetail.id.slice(0, 8)} · ${boot.mode === 'demo' ? '演示数据' : '真实账号'}`}
          onClose={() => setTaskDetail(null)}
        >
          <div className="plan-list">
            {taskDetail.items.map((i) => (
              <div className="plan-row" key={i.file.id}>
                <IconFile file={i.file} />
                <div>
                  <strong>{i.file.name}</strong>
                  <p>{i.error || i.result || i.changes.join('；')}</p>
                  {!!i.history?.length && (
                    <details>
                      <summary>阶段与暂停历史（{i.history.length}）</summary>
                      {i.history.map((event, index) => (
                        <p key={index}>
                          {new Date(event.time).toLocaleTimeString('zh-CN')} · {event.message}
                        </p>
                      ))}
                    </details>
                  )}
                </div>
                <Badge
                  tone={
                    i.state === 'succeeded'
                      ? 'green'
                      : i.state === 'failed' || i.state === 'unknown'
                        ? 'amber'
                        : 'gray'
                  }
                >
                  {states[i.state]}
                </Badge>
              </div>
            ))}
          </div>
          <footer className="modal-footer">
            <Button onClick={() => run(async () => notify(await api.exportReport(taskDetail.id)))}>
              <Download size={15} />
              导出明细
            </Button>
            <Button primary onClick={() => setTaskDetail(null)}>
              完成
            </Button>
          </footer>
        </Modal>
      )}
      {cleanup && (
        <Modal
          title={
            cleanup.kind === 'tasks'
              ? '删除本地任务记录'
              : cleanup.kind === 'account'
                ? '移除本地账号'
                : '确认重置本地数据'
          }
          onClose={() => {
            if (!busy) setCleanup(null);
          }}
        >
          <div className="modal-body">
            <p>
              {cleanup.kind === 'tasks'
                ? `将永久删除 ${cleanup.ids!.length} 条本机任务记录，包括明细、调用统计和日志。需要留档请先导出报告。删除暂停任务后将不能继续或对账，结果未知的操作请先自行核实。`
                : cleanup.kind === 'account'
                  ? `将移除 ${cleanup.account!.email} 的本地账号、所有授权连接、头像和扫描结果。历史任务保留，重新授权后可继续处理。`
                  : '将永久清空本软件保存的所有本地账号、授权、头像、任务和设置。需要再次使用时须重新导入并授权。'}
            </p>
            <p className="form-hint">
              此操作不会删除网盘文件，也不会撤销已完成的分享、移动或所有权转让。
            </p>
            {cleanup.kind === 'reset' && (
              <label className="field">
                输入“清空本地数据”确认
                <input
                  aria-label="重置确认文字"
                  value={resetText}
                  onChange={(e) => setResetText(e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
          </div>
          <footer className="modal-footer">
            <Button disabled={busy} onClick={() => setCleanup(null)}>
              取消
            </Button>
            <Button
              danger
              disabled={busy || (cleanup.kind === 'reset' && resetText !== '清空本地数据')}
              onClick={executeCleanup}
            >
              {busy ? '正在处理…' : '确认删除本地数据'}
            </Button>
          </footer>
        </Modal>
      )}
      {updateConfirm && (
        <Modal
          title="重启并更新软件"
          onClose={() => {
            if (!busy) setUpdateConfirm(false);
          }}
        >
          <div className="modal-body">
            <p>
              更新到 {boot.update?.latest}
              。软件将退出、替换程序文件并重新打开。账号、设置和任务记录会保留。
            </p>
            <p className="form-hint">
              请先暂停任务并等待请求结束。旧程序会保留为同目录下的 backup
              文件夹；更新失败时可恢复。更新不会删除网盘文件。
            </p>
          </div>
          <footer className="modal-footer">
            <Button disabled={busy} onClick={() => setUpdateConfirm(false)}>
              取消
            </Button>
            <Button
              primary
              disabled={busy || loading || boot.update?.status !== 'ready'}
              onClick={() =>
                run(async () => {
                  await api.installUpdate();
                })
              }
            >
              确认重启更新
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
