export const FOLDER = 'application/vnd.google-apps.folder';
export const SHORTCUT = 'application/vnd.google-apps.shortcut';
export type Role = 'reader' | 'commenter' | 'writer' | 'owner' | 'organizer' | 'fileOrganizer';
export interface Account {
  id: string;
  email: string;
  name: string;
  permissionId: string;
  connections: number;
  ready: boolean;
  photoLink?: string;
  avatar?: string;
  avatarCheckedAt?: number;
}
export interface Permission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: Role;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  pendingOwner?: boolean;
  deleted?: boolean;
  view?: string;
  permissionDetails?: { inherited?: boolean; inheritedFrom?: string }[];
}
export interface FileEntry {
  childrenScanned?: boolean;
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size?: string;
  quotaBytesUsed?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  ownedByMe?: boolean;
  owners?: { emailAddress?: string; displayName?: string; permissionId?: string }[];
  trashed?: boolean;
  driveId?: string;
  resourceKey?: string;
  capabilities?: Record<string, boolean>;
  permissions?: Permission[];
  path?: string;
  depth?: number;
  inheritedPermissionsDisabled?: boolean;
  writersCanShare?: boolean;
  copyRequiresWriterPermission?: boolean;
  appProperties?: Record<string, string>;
}
export interface ScanProgress {
  pages: number;
  items: number;
  requestId?: string;
}
export interface ScanResult {
  maxDepth?: number;
  rootId?: string;
  files: FileEntry[];
  complete: boolean;
  warnings: string[];
}
export interface Settings {
  /** Legacy field is accepted when loading old settings; no global task cap. */
  concurrency?: number;
  accountConcurrency: number;
  connectionConcurrency: number;
}
export interface Collaborator {
  email: string;
  type: 'user' | 'group' | 'domain';
  role: 'reader' | 'commenter' | 'writer';
}
export interface ShareConfig {
  public: 'keep' | 'off' | 'reader' | 'commenter' | 'writer';
  collaborators: 'keep' | 'add' | 'update' | 'replace' | 'remove';
  people: Collaborator[];
  atLeast: boolean;
  notify: boolean;
  writersCanShare: 'keep' | 'yes' | 'no';
  copyRestriction: 'keep' | 'yes' | 'no';
  removeGroups: boolean;
  removeDomains: boolean;
  clearUsers?: boolean;
  mappings?: { fileId: string; person: Collaborator }[];
}
export interface ActionRequest {
  ownerFilter?: 'all' | 'mine' | 'others' | 'unknown';
  kind: 'share' | 'transfer' | 'trash' | 'restore' | 'rename' | 'move' | 'copy' | 'mkdir';
  accountId: string;
  ids: string[];
  recursive: boolean;
  targetAccountId?: string;
  removeSource?: boolean;
  moveToTargetRoot?: boolean;
  // Frozen execution policy for persisted tasks; new recursive transfers always enable it.
  skipUntransferable?: boolean;
  name?: string;
  destination?: string;
  share?: ShareConfig;
}
export interface Mutation {
  kind: 'create' | 'update' | 'delete';
  permission?: Partial<Permission>;
  id?: string;
  label: string;
}
export interface PlanItem {
  transferRoot?: boolean;
  file: FileEntry;
  mutations: Mutation[];
  changes: string[];
  blocked?: string;
  skipReason?: string;
  signature?: string;
}
export interface Plan {
  id: string;
  request: ActionRequest;
  createdAt: string;
  items: PlanItem[];
  complete: boolean;
  warnings: string[];
  ownershipNotice?: { foreign: number; unknown: number };
}
export type ItemState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'waiting_auth';
export interface ApiCounters {
  reads: number;
  writes: number;
  retries: number;
  rateLimits: number;
}
export interface TaskEvent {
  time: string;
  kind: string;
  message: string;
}
export interface RuntimeLimits {
  accounts: {
    accountId: string;
    active: number;
    limit: number;
    ceiling: number;
    waitingMs: number;
    requestsPerMinute: number;
    reason?: string;
  }[];
  projects: {
    project: string;
    active: number;
    limit: number;
    ceiling: number;
    waitingMs: number;
    reason?: string;
  }[];
}
export interface TaskItem extends PlanItem {
  api?: ApiCounters;
  history?: TaskEvent[];
  transferStage?: 'inviting' | 'invited' | 'accepting' | 'accepted' | 'verified';
  transferPermissionId?: string;
  transferVerified?: boolean;
  transferCleanupStarted?: boolean;
  state: ItemState;
  error?: string;
  started?: boolean;
  result?: string;
  attempts: number;
  outputId?: string;
  resultFile?: FileEntry;
}
export interface Task {
  api?: ApiCounters;
  total?: number;
  succeeded?: number;
  skipped?: number;
  id: string;
  title: string;
  request: ActionRequest;
  createdAt: string;
  updatedAt: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'partial';
  items: TaskItem[];
  paused: boolean;
}
export interface Connection {
  id: string;
  accountId?: string;
  clientId: string;
  projectId?: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  disabled?: boolean;
  error?: string;
}
export interface Bootstrap {
  update?: UpdateState;
  runtime?: RuntimeLimits;
  mode: 'demo' | 'live';
  demoEnabled?: boolean;
  accounts: Account[];
  tasks: Task[];
  settings: Settings;
  connections: {
    id: string;
    accountId?: string;
    clientId: string;
    ready: boolean;
    error?: string;
  }[];
}
export interface Bridge {
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  deleteTasks(ids: string[]): Promise<number>;
  removeAccount(id: string): Promise<void>;
  resetLocalData(confirmation: string): Promise<void>;
  refreshAvatars(): Promise<string>;
  onScanProgress(callback: (progress: ScanProgress) => void): () => void;
  task(taskId: string): Promise<Task>;
  bootstrap(): Promise<Bootstrap>;
  list(
    accountId: string,
    parent: string,
    recursive?: boolean,
    trashed?: boolean,
    requestId?: string,
    maxDepth?: number,
  ): Promise<ScanResult>;
  permissions(accountId: string, fileId: string): Promise<Permission[]>;
  inspect(accountId: string, fileId: string, resourceKey?: string): Promise<FileEntry>;
  preview(request: ActionRequest): Promise<Plan>;
  submit(planId: string): Promise<Task>;
  control(taskId: string, action: 'pause' | 'resume' | 'retry'): Promise<void>;
  settings(value: Settings): Promise<void>;
  importCredentials(): Promise<string>;
  authorize(connectionId: string): Promise<string>;
  disconnect(connectionId: string): Promise<void>;
  switchMode(mode: 'demo' | 'live'): Promise<void>;
  exportSnapshot(
    accountId: string,
    files: FileEntry[],
    complete: boolean,
    rootId?: string,
    maxDepth?: number,
  ): Promise<string>;
  exportReport(taskId: string): Promise<string>;
  copyLinks(links: string[]): Promise<void>;
  openExternal(url: string): Promise<void>;
}
export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported';
  current: string;
  latest?: string;
  percent?: number;
  error?: string;
}
export interface DriveApi {
  get(account: string, id: string): Promise<FileEntry>;
  list(
    account: string,
    parent: string,
    recursive?: boolean,
    trashed?: boolean,
    onProgress?: (progress: ScanProgress) => void,
    maxDepth?: number,
    knownFolder?: FileEntry,
  ): Promise<ScanResult>;
  permissions(account: string, id: string): Promise<Permission[]>;
  createPermission(
    account: string,
    id: string,
    permission: Partial<Permission>,
    notify?: boolean,
  ): Promise<Permission>;
  updatePermission(
    account: string,
    id: string,
    permissionId: string,
    body: Partial<Permission>,
    transfer?: boolean,
  ): Promise<Permission>;
  deletePermission(account: string, id: string, permissionId: string): Promise<void>;
  update(
    account: string,
    id: string,
    body: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<FileEntry>;
  create(account: string, body: Record<string, unknown>): Promise<FileEntry>;
  copy(account: string, id: string, body: Record<string, unknown>): Promise<FileEntry>;
  findOperation(account: string, marker: string): Promise<FileEntry | undefined>;
}
export const DEFAULT_SETTINGS: Settings = {
  accountConcurrency: 18,
  connectionConcurrency: 6,
};
export const DEFAULT_SHARE: ShareConfig = {
  public: 'keep',
  collaborators: 'keep',
  people: [],
  atLeast: false,
  notify: false,
  writersCanShare: 'keep',
  copyRestriction: 'keep',
  removeGroups: false,
  removeDomains: false,
};
export const TITLES: Record<ActionRequest['kind'], string> = {
  share: '批量分享设置',
  transfer: '所有权转让',
  trash: '移入回收站',
  restore: '恢复文件',
  rename: '重命名',
  move: '移动文件',
  copy: '创建副本',
  mkdir: '新建文件夹',
};

export function normalizeSettings(value: Partial<Settings> = {}): Settings {
  const bounded = (n: number | undefined, max: number) =>
    Number.isInteger(n) && n! > 0 ? Math.min(n!, max) : max;
  return {
    accountConcurrency: bounded(value.accountConcurrency, 18),
    connectionConcurrency: bounded(value.connectionConcurrency, 6),
  };
}
