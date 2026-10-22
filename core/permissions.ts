import type {
  Account,
  ActionRequest,
  FileEntry,
  Collaborator,
  Mutation,
  Permission,
  ShareConfig,
} from './types.js';
export function ownershipOf(file: FileEntry, account?: Account): 'mine' | 'others' | 'unknown' {
  if (typeof file.ownedByMe === 'boolean') return file.ownedByMe ? 'mine' : 'others';
  if (!file.owners?.length || !account) return 'unknown';
  const known = file.owners.filter((o) => o.permissionId || o.emailAddress);
  if (!known.length) return 'unknown';
  return known.some(
    (o) =>
      (o.permissionId && o.permissionId === account.permissionId) ||
      (o.emailAddress && o.emailAddress.toLowerCase() === account.email.toLowerCase()),
  )
    ? 'mine'
    : 'others';
}
export function matchesOwner(
  file: FileEntry,
  filter: ActionRequest['ownerFilter'],
  account?: Account,
) {
  return !filter || filter === 'all' || ownershipOf(file, account) === filter;
}
export const subject = (p: Partial<Permission>) =>
  `${p.type}:${(p.emailAddress || p.domain || '').toLowerCase()}`;
export const inherited = (p: Permission) =>
  p.view === 'metadata' || !!p.permissionDetails?.some((d) => d.inherited === true);
export const signature = (ps: Permission[]) =>
  JSON.stringify(
    ps
      .filter((p) => !p.deleted)
      .map((p) => [p.id, p.type, p.role, p.emailAddress, p.domain, p.pendingOwner, p.view])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
const ranks: Record<string, number> = {
  reader: 1,
  commenter: 2,
  writer: 3,
  owner: 4,
  organizer: 4,
  fileOrganizer: 3,
};
export const roleRank = (role: string) => ranks[role] || 0;
export function personPermission(p: Collaborator): Partial<Permission> {
  return {
    type: p.type,
    role: p.role,
    ...(p.type === 'domain'
      ? { domain: p.email.toLowerCase() }
      : { emailAddress: p.email.toLowerCase() }),
  };
}
export function planPermissions(perms: Permission[], cfg: ShareConfig): Mutation[] {
  const operations: Mutation[] = [];
  const add = (p: Partial<Permission>, atLeast: boolean) => {
    const existing = perms.find(
      (e) => !e.deleted && subject(e) === subject(p) && e.view !== 'metadata',
    );
    if (existing?.role === 'owner') return;
    if (existing) {
      if (existing.role === p.role || (atLeast && ranks[existing.role] >= ranks[p.role!])) return;
      if (inherited(existing))
        throw new Error(`无法在子项直接修改继承权限：${p.emailAddress || p.domain || '公开链接'}`);
      operations.push({
        kind: 'update',
        id: existing.id,
        permission: { role: p.role },
        label: `${p.emailAddress || p.domain || '任何人'} → ${p.role}`,
      });
    } else
      operations.push({
        kind: 'create',
        permission: p,
        label: `添加 ${p.emailAddress || p.domain || '任何人'} · ${p.role}`,
      });
  };
  const remove = (p: Permission) => {
    if (p.role === 'owner') return;
    if (inherited(p))
      throw new Error(
        `存在继承权限：${p.emailAddress || p.domain || p.type}。请显式处理父目录，当前计划不会扩大范围。`,
      );
    if (!operations.some((o) => o.kind === 'delete' && o.id === p.id))
      operations.push({
        kind: 'delete',
        id: p.id,
        permission: { type: p.type, emailAddress: p.emailAddress, domain: p.domain },
        label: `移除 ${p.emailAddress || p.domain || p.type}`,
      });
  };
  if (cfg.public !== 'keep') {
    if (cfg.public === 'off') perms.filter((p) => p.type === 'anyone').forEach(remove);
    else add({ type: 'anyone', role: cfg.public }, false);
  }
  const people = cfg.people.map(personPermission);
  if (cfg.collaborators === 'update')
    people
      .filter((p) =>
        perms.some((e) => !e.deleted && e.view !== 'metadata' && subject(e) === subject(p)),
      )
      .forEach((p) => add(p, cfg.atLeast));
  if (cfg.collaborators === 'add' || cfg.collaborators === 'replace')
    people.forEach((p) => add(p, cfg.atLeast));
  if (cfg.collaborators === 'remove')
    perms.filter((p) => people.some((w) => subject(w) === subject(p))).forEach(remove);
  if (cfg.collaborators === 'replace')
    perms
      .filter((p) => p.type === 'user' && !people.some((w) => subject(w) === subject(p)))
      .forEach(remove);
  if (cfg.removeGroups) perms.filter((p) => p.type === 'group').forEach(remove);
  if (cfg.removeDomains) perms.filter((p) => p.type === 'domain').forEach(remove);
  return operations.sort((a, b) => Number(a.kind === 'delete') - Number(b.kind === 'delete'));
}
