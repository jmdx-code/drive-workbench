/** Quote a CSV field and keep untrusted text from becoming a spreadsheet formula. */
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\t\r\n]|^\s*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
