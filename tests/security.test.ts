import { describe, expect, it } from 'vitest';
import { csvCell } from '../core/csv.js';
import { snapshotCsv } from '../core/snapshot.js';

describe('CSV export security', () => {
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '  =1', ' \t+1'])(
    'neutralizes formula-like field %j',
    (value) => expect(csvCell(value)).toBe('"\'' + value + '"'),
  );
  it('retains ordinary values and quotes embedded delimiters', () => {
    expect(csvCell('report,"Q1"\nnotes')).toBe('"report,""Q1""\nnotes"');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(undefined)).toBe('""');
  });
  it('neutralizes untrusted Drive filenames in the actual snapshot export', () => {
    const csv = snapshotCsv([
      {
        id: 'example-file',
        name: '  =1+1',
        mimeType: 'text/plain',
        parents: [],
      },
    ]);
    expect(csv).toContain('"\'  =1+1"');
  });
});
