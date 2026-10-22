import { FOLDER, type FileEntry } from './types.js';

export const ORPHAN_NODE = 'local:unfiled';
export interface DirectorySize {
  quotaBytes: bigint;
  quotaUnknown: number;
  bytes: bigint;
  unknown: number;
  files: number;
  folders: number;
}

/** One in-memory index per explicit scan. No network or persistent cache. */
export function directoryIndex(files: FileEntry[], rootId?: string) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const parent = new Map<string, string>();
  for (const f of byId.values()) {
    const p = f.parents.find((id) => id !== f.id && byId.get(id)?.mimeType === FOLDER);
    if (p) parent.set(f.id, p);
  }
  // Malformed/cyclic parent metadata must not hide files or hang rendering.
  const settled = new Set<string>();
  for (const id of byId.keys()) {
    const chain = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor && !settled.has(cursor)) {
      if (chain.has(cursor)) {
        parent.delete(cursor);
        break;
      }
      chain.add(cursor);
      cursor = parent.get(cursor);
    }
    for (const item of chain) settled.add(item);
  }
  if (rootId) {
    const orphans = [...byId.values()].filter(
      (f) => !parent.has(f.id) && !f.parents.includes(rootId) && f.id !== rootId,
    );
    if (orphans.length) {
      byId.set(ORPHAN_NODE, {
        id: ORPHAN_NODE,
        name: '共享目录或未分类的文件',
        mimeType: FOLDER,
        parents: [],
      });
      for (const f of orphans) parent.set(f.id, ORPHAN_NODE);
    }
  }
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const sizes = new Map<string, DirectorySize>();
  for (const f of byId.values()) {
    const p = parent.get(f.id) || '';
    const group = children.get(p) || [];
    group.push(f.id);
    children.set(p, group);
    const folder = f.mimeType === FOLDER;
    const known = !folder && /^\d+$/.test(f.size || '');
    sizes.set(f.id, {
      quotaBytes: !folder && /^\d+$/.test(f.quotaBytesUsed || '') ? BigInt(f.quotaBytesUsed!) : 0n,
      quotaUnknown:
        f.childrenScanned === false || (!folder && !/^\d+$/.test(f.quotaBytesUsed || '')) ? 1 : 0,
      bytes: known ? BigInt(f.size!) : 0n,
      unknown: f.childrenScanned === false || (!folder && !known) ? 1 : 0,
      files: folder ? 0 : 1,
      folders: 0,
    });
  }
  const queue = [...(children.get('') || [])];
  for (const id of queue) depth.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const child of children.get(id) || []) {
      depth.set(child, depth.get(id)! + 1);
      queue.push(child);
    }
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    const id = queue[i],
      p = parent.get(id);
    if (!p) continue;
    const source = sizes.get(id)!,
      target = sizes.get(p)!;
    target.quotaBytes += source.quotaBytes;
    target.quotaUnknown += source.quotaUnknown;
    target.bytes += source.bytes;
    target.unknown += source.unknown;
    target.files += source.files;
    target.folders += source.folders + Number(byId.get(id)!.mimeType === FOLDER);
  }
  return { byId, parent, children, depth, sizes };
}

export function bytesLabel(bytes: bigint) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0,
    divisor = 1n;
  while (bytes >= divisor * 1024n && unit < units.length - 1) {
    divisor *= 1024n;
    unit++;
  }
  return `${unit ? (Number((bytes * 10n) / divisor) / 10).toFixed(1) : bytes} ${units[unit]}`;
}
export function directorySizeLabel(size: DirectorySize, complete = true) {
  const value = size.unknown && size.bytes === 0n ? '大小未知' : bytesLabel(size.bytes);
  return `${value}${size.unknown && size.bytes > 0n ? ` + ${size.unknown} 项未知` : ''}${complete ? '' : '（扫描不完整）'}`;
}

export function quotaSizeLabel(size: DirectorySize) {
  return size.quotaUnknown && size.quotaBytes === 0n
    ? '占用未知'
    : '占用 ' +
        bytesLabel(size.quotaBytes) +
        (size.quotaUnknown ? ' + ' + size.quotaUnknown + ' 项未知' : '');
}
export function directoryPath(id: string, index: ReturnType<typeof directoryIndex>) {
  const names: string[] = [],
    seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const file = index.byId.get(current);
    if (!file) break;
    names.push(file.name);
    current = index.parent.get(current);
  }
  return '/' + names.reverse().join('/');
}

export function directoryTotals(index: ReturnType<typeof directoryIndex>): DirectorySize {
  const total: DirectorySize = {
    bytes: 0n,
    unknown: 0,
    quotaBytes: 0n,
    quotaUnknown: 0,
    files: 0,
    folders: 0,
  };
  for (const id of index.children.get('') || []) {
    const size = index.sizes.get(id)!;
    total.bytes += size.bytes;
    total.unknown += size.unknown;
    total.quotaBytes += size.quotaBytes;
    total.quotaUnknown += size.quotaUnknown;
    total.files += size.files;
    total.folders +=
      size.folders + Number(id !== ORPHAN_NODE && index.byId.get(id)!.mimeType === FOLDER);
  }
  return total;
}
