import { FOLDER, SHORTCUT, type FileEntry } from '../core/types';

// Presentation only: a known MIME takes precedence; extensions cover generic MIME files.
export function fileVisual(file: Pick<FileEntry, 'mimeType' | 'name'>) {
  const mime = file.mimeType.toLowerCase();
  if (mime === FOLDER) return 'folder';
  if (mime === SHORTCUT) return 'shortcut';
  if (/spreadsheet|excel/.test(mime)) return 'sheet';
  if (/presentation|powerpoint/.test(mime)) return 'slides';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/zip|compressed|archive|rar|7z/.test(mime)) return 'archive';
  if (/document|word|text\//.test(mime)) return 'doc';
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (/^(xlsx?|xlsm|ods|csv|tsv)$/.test(ext)) return 'sheet';
  if (/^(pptx?|ppsx?|odp)$/.test(ext)) return 'slides';
  if (ext === 'pdf') return 'pdf';
  if (/^(png|jpe?g|gif|webp|svg|bmp|heic|avif|tiff?)$/.test(ext)) return 'image';
  if (/^(mp4|mov|mkv|avi|webm|m4v|wmv|flv)$/.test(ext)) return 'video';
  if (/^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(ext)) return 'audio';
  if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return 'archive';
  return 'doc';
}
