import {
  directoryIndex,
  directoryTotals,
  directorySizeLabel,
  quotaSizeLabel,
  directoryPath,
  ORPHAN_NODE,
} from './directory.js';
import { fileLink, permissionRows, fileIcon } from './presentation.js';
import { FOLDER, type FileEntry } from './types.js';
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const date = (value?: string) =>
  value ? new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : '—';
export function snapshotHtml(files: FileEntry[], title: string, rootId?: string) {
  const index = directoryIndex(files, rootId),
    html: string[] = [];
  const sorted = (parent: string) =>
    [...(index.children.get(parent) || [])].sort((a, b) =>
      a === ORPHAN_NODE
        ? 1
        : b === ORPHAN_NODE
          ? -1
          : Number(index.byId.get(b)!.mimeType === FOLDER) -
              Number(index.byId.get(a)!.mimeType === FOLDER) ||
            index.byId.get(a)!.name.localeCompare(index.byId.get(b)!.name, 'zh-CN'),
    );
  const stack = sorted('')
    .reverse()
    .map((id) => ({ id, close: false }));
  while (stack.length) {
    const { id, close } = stack.pop()!;
    if (close) {
      html.push('</section></details>');
      continue;
    }
    const f = index.byId.get(id)!,
      virtual = id === ORPHAN_NODE,
      folder = f.mimeType === FOLDER,
      size = index.sizes.get(id)!;
    const name = escapeHtml(f.name),
      link = virtual ? '' : escapeHtml(fileLink(f));
    const check = virtual
      ? '<span class="check-space"></span>'
      : `<input class="file-check" type="checkbox" value="${link}" aria-label="选择 ${name}">`;
    const nameHtml = virtual
      ? name
      : `<a href="${link}" target="_blank" rel="noopener">${name}</a>`;
    const row = `<div class="entry-row"><span class="name" title="${escapeHtml(directoryPath(id, index))}">${check}<span>${fileIcon(f)}</span>${nameHtml}${folder ? `<small class="count" title="后代文件数量">${f.childrenScanned === false ? '未扫描' : size.files}</small>` : ''}</span><span>${escapeHtml(f.childrenScanned === false ? '下级未扫描' : directorySizeLabel(size))}<small>${escapeHtml(quotaSizeLabel(size))}</small></span><span>${date(f.createdTime)}</span><span>${date(f.modifiedTime)}</span><span class="permissions">${
      virtual
        ? ''
        : permissionRows(f)
            .map((x) => `<span>${escapeHtml(x)}</span>`)
            .join('')
    }</span></div>`;
    const search = escapeHtml(
      (f.name + ' ' + f.id + ' ' + permissionRows(f).join(' ')).toLowerCase(),
    );
    if (folder) {
      html.push(
        `<details class="entry" data-search="${search}"><summary>${row}</summary><section class="children">`,
      );
      if (f.childrenScanned === false) html.push('<p>下级未扫描，请在应用中指定此目录后扫描。</p>');
      stack.push({ id, close: true });
      for (const child of sorted(id).reverse()) stack.push({ id: child, close: false });
    } else html.push(`<article class="entry" data-search="${search}">${row}</article>`);
  }
  const totals = directoryTotals(index);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f5f7f6;--panel:#fff;--text:#17212b;--line:#dfe6e1;--muted:#46534c;--hover:#edf4ef}*{box-sizing:border-box}body{font:16px system-ui;background:var(--bg);color:var(--text);margin:0;padding:20px}h1{font-size:20px;margin:0 0 8px}.meta{color:var(--muted);line-height:1.8}nav{position:sticky;top:0;z-index:3;background:var(--bg);padding:12px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}input[type=search]{min-width:200px;max-width:400px;flex:1}button,input[type=search]{padding:8px 12px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--text)}button{cursor:pointer}.tree{background:var(--panel);border:1px solid var(--line);overflow:auto;max-height:calc(100vh - 180px)}.entry-row{display:grid;grid-template-columns:minmax(260px,1fr) 160px 100px 100px 310px;gap:12px;align-items:center;padding:9px 12px;min-width:1000px;border-bottom:1px solid var(--line)}.header{position:sticky;top:0;z-index:2;background:var(--panel);font-weight:600}.entry-row:hover{background:var(--hover)}.name{display:flex;align-items:center;gap:7px;min-width:0}.name a{overflow-wrap:anywhere;color:inherit;text-decoration:none}.name a:hover{text-decoration:underline;color:#2c8063}.count{background:var(--hover);border-radius:9px;padding:1px 7px;flex-shrink:0}.entry-row small{display:block;color:var(--muted);font-size:14px;margin-top:3px}.permissions{display:grid;max-height:96px;overflow:auto;overscroll-behavior:contain;gap:4px;font-size:14px;overflow-wrap:anywhere}.children{padding-left:22px;border-left:1px solid var(--line);margin-left:11px}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary .name:before{content:'▸';width:10px}details[open]>summary .name:before{content:'▾'}input[type=checkbox],.check-space{width:18px;height:18px;flex-shrink:0;accent-color:#2c725e}#preview-warning{padding:9px;border:1px solid #d69b42;background:#fdf4de;color:#684c16}#copy-status{color:var(--muted)}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{--bg:#14231d;--panel:#1c2e25;--text:#dfebe4;--line:#354e40;--muted:#a3baac;--hover:#293f32}}
</style><h1>${escapeHtml(title)}</h1><div class="meta"><strong>统计对象：</strong>${totals.files} 个文件 · ${totals.folders} 个文件夹 | ${escapeHtml(directorySizeLabel(totals))}<br><strong>生成时间：</strong> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Taipei' })} · ${escapeHtml(quotaSizeLabel(totals))} · 本次扫描快照</div><div id="preview-warning">交互需要使用浏览器打开本地 HTML；Google Drive 预览可能禁止脚本运行。</div><nav><input type="search" aria-label="搜索目录" placeholder="搜索名称、ID 或授权邮箱"><button id="expand">展开全部</button><button id="collapse">收起全部</button><button id="select">全选可见</button><button id="clear">清空所有</button><button id="copy">复制链接</button><span id="count">已选 0 项</span><span id="copy-status" role="status"></span></nav><div class="tree"><div class="entry-row header"><span>名称 / 路径</span><span>大小 / 存储占用</span><span>创建时间</span><span>修改时间</span><span>邮箱与权限（扫描时）</span></div>${html.join('')}</div><script>
document.getElementById('preview-warning').hidden=true;
const all=()=>[...document.querySelectorAll('.file-check')];const visible=()=>all().filter(el=>{let node=el;while(node&&node!==document.body){if(node.hidden)return false;if(node.tagName==='DETAILS'&&!node.open&&!node.querySelector('summary')?.contains(el))return false;node=node.parentElement;}return el.getClientRects().length>0;});
const count=()=>{const checked=all().filter(x=>x.checked), shown=visible();document.getElementById('count').textContent='已选 '+checked.length+' 项'+(checked.filter(x=>!shown.includes(x)).length?'（含折叠/筛选隐藏项）':'');document.getElementById('select').textContent=shown.length&&shown.every(x=>x.checked)?'清空所有':'全选可见';};
document.addEventListener('change',count);document.addEventListener('toggle',count,true);document.querySelectorAll('.file-check,a,.permissions').forEach(x=>x.addEventListener('click',e=>e.stopPropagation()));
document.getElementById('expand').onclick=()=>{document.querySelectorAll('details').forEach(x=>x.open=true);count()};document.getElementById('collapse').onclick=()=>{document.querySelectorAll('details').forEach(x=>x.open=false);count()};
document.getElementById('select').onclick=()=>{const shown=visible();if(shown.length&&shown.every(x=>x.checked))all().forEach(x=>x.checked=false);else shown.forEach(x=>x.checked=true);count()};document.getElementById('clear').onclick=()=>{all().forEach(x=>x.checked=false);count()};
let beforeSearch=null;document.querySelector('input[type=search]').oninput=e=>{const q=e.target.value.toLowerCase();if(q&&!beforeSearch)beforeSearch=new Set([...document.querySelectorAll('details[open]')]);document.querySelectorAll('.entry').forEach(x=>x.hidden=false);if(q){document.querySelectorAll('details').forEach(x=>x.open=true);document.querySelectorAll('article').forEach(x=>x.hidden=!x.dataset.search.includes(q));[...document.querySelectorAll('details')].reverse().forEach(x=>x.hidden=!x.dataset.search.includes(q)&&![...x.querySelectorAll('.entry')].some(c=>!c.hidden));}else if(beforeSearch){document.querySelectorAll('details').forEach(x=>x.open=beforeSearch.has(x));beforeSearch=null;}count();};
document.getElementById('copy').onclick=async()=>{const checked=all().filter(x=>x.checked);if(!checked.length){document.getElementById('copy-status').textContent='请先勾选文件';return;}const text=checked.map(x=>x.value).join('\\n');try{await navigator.clipboard.writeText(text);}catch{const a=document.createElement('textarea');a.value=text;document.body.append(a);a.select();const ok=document.execCommand('copy');a.remove();if(!ok){document.getElementById('copy-status').textContent='复制失败，请检查浏览器剪贴板权限';return;}}document.getElementById('copy-status').textContent='已复制 '+checked.length+' 个链接';};
</script></html>`;
}
export function snapshotCsv(files: FileEntry[], rootId?: string) {
  const index = directoryIndex(files, rootId);
  const cell = (value: string) =>
    '"' + (/^[=+@\-\t\r\n]/.test(value) ? "'" : '') + value.replace(/"/g, '""') + '"';
  const rows = [
    [
      '名称',
      '文件ID',
      '路径',
      '大小（已知字节）',
      '大小未知文件数',
      '存储占用（已知字节）',
      '占用未知文件数',
      '创建时间',
      '修改时间',
      '所有者邮箱',
      '邮箱与权限',
      '链接',
    ],
    ...files.map((f) => [
      f.name,
      f.id,
      directoryPath(f.id, index),
      f.childrenScanned === false
        ? ''
        : f.mimeType === FOLDER
          ? index.sizes.get(f.id)!.bytes.toString()
          : f.size || '',
      index.sizes.get(f.id)!.unknown.toString(),
      f.childrenScanned === false
        ? ''
        : f.mimeType === FOLDER
          ? index.sizes.get(f.id)!.quotaBytes.toString()
          : f.quotaBytesUsed || '',
      index.sizes.get(f.id)!.quotaUnknown.toString(),
      f.createdTime || '',
      f.modifiedTime || '',
      f.owners?.map((o) => o.emailAddress || '').join('; ') || '',
      permissionRows(f).join('; '),
      fileLink(f),
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
