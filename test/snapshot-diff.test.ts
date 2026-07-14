import { describe, it, expect } from 'vitest';
import { diffSnapshot } from '../src/scan/snapshot.js';
import type { FileRecord } from '../src/scan/types.js';

const f = (path: string, hash: string): FileRecord => ({
  path,
  blob_hash: hash,
  size: 1,
  category: 'source',
});

describe('diffSnapshot', () => {
  it('reports nothing changed for identical file sets', () => {
    const files = [f('a.ts', 'h1'), f('b.ts', 'h2')];
    const diff = diffSnapshot(files, files);
    expect(diff).toEqual({ added: [], modified: [], deleted: [], renamed: [], unchanged: 2 });
  });

  it('detects added, modified, and deleted', () => {
    const prev = [f('a.ts', 'h1'), f('b.ts', 'h2')];
    const curr = [f('a.ts', 'h1-changed'), f('c.ts', 'h3')];
    const diff = diffSnapshot(prev, curr);
    expect(diff.modified).toEqual(['a.ts']);
    expect(diff.added).toEqual(['c.ts']);
    expect(diff.deleted).toEqual(['b.ts']);
    expect(diff.renamed).toEqual([]);
  });

  it('reports a moved file with identical content as a rename, not add+delete', () => {
    const prev = [f('old/name.ts', 'same')];
    const curr = [f('new/name.ts', 'same')];
    const diff = diffSnapshot(prev, curr);
    expect(diff.renamed).toEqual([{ from: 'old/name.ts', to: 'new/name.ts' }]);
    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });
});
