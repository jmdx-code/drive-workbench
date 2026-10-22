import { describe, it, expect } from 'vitest';
import { directoryIndex, directorySizeLabel } from '../core/directory';
import { FOLDER, type FileEntry } from '../core/types';
const file = (id: string, parent: string, size?: string, folder = false): FileEntry => ({
  id,
  name: id,
  parents: [parent],
  size,
  mimeType: folder ? FOLDER : 'application/pdf',
});
describe('扫描目录的本地索引与大小', () => {
  it('按后代汇总大小并区分未知、零字节、空文件夹及不可见父目录', () => {
    const d = directoryIndex([
      file('rootFolder', 'outside', undefined, true),
      file('nested', 'rootFolder', undefined, true),
      file('a', 'nested', '2048'),
      file('b', 'nested'),
      file('zero', 'rootFolder', '0'),
      file('empty', 'rootFolder', undefined, true),
      file('orphan', 'missing', '16'),
    ]);
    expect(d.sizes.get('rootFolder')).toMatchObject({
      bytes: 2048n,
      unknown: 1,
      files: 3,
      folders: 2,
    });
    expect(directorySizeLabel(d.sizes.get('rootFolder')!)).toBe('2.0 KB + 1 项未知');
    expect(directorySizeLabel(d.sizes.get('zero')!)).toBe('0 B');
    expect(directorySizeLabel(d.sizes.get('empty')!)).toBe('0 B');
    expect(d.children.get('')).toEqual(['rootFolder', 'orphan']);
  });
  it('大整数保持精确，深层目录无需递归，异常父链不丢项', () => {
    const files = Array.from({ length: 12000 }, (_, i) =>
      file(String(i), String(i - 1), undefined, true),
    );
    files.push(file('huge', '11999', '9007199254740993'));
    const d = directoryIndex(files);
    expect(d.sizes.get('0')!.bytes).toBe(9007199254740993n);
    expect(d.depth.get('huge')).toBe(12000);
    const cycle = directoryIndex([
      file('a', 'b', undefined, true),
      file('b', 'a', undefined, true),
      file('c', 'b', '1024'),
    ]);
    expect(cycle.depth.size).toBe(3);
  });
});
