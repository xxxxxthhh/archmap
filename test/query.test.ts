import { describe, it, expect } from 'vitest';
import { contextFor, impactFor, evidenceFor } from '../src/query/queries.js';
import type { Evidence, Node } from '../src/model/types.js';

const ev = (path: string, symbol?: string): Evidence => ({
  repository: 'local',
  commit: 'working-tree',
  path,
  ...(symbol ? { symbol } : {}),
  analyzer: 'typescript',
  analyzer_version: '0.1.0',
  blob_hash: 'sha256:x',
  extract_hash: 'sha256:y',
});

// c imports a; a imports b and external pkg.
const nodes: Node[] = [
  { id: 'node_root', slug: 'repository', kind: 'system', title: 'repo', claims: [], relations: [] },
  { id: 'node_dir', slug: 'src', kind: 'module', title: 'src', scope: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }, claims: [], relations: [] },
  {
    id: 'node_a',
    slug: 'src-a-ts',
    kind: 'module',
    title: 'src/a.ts',
    scope: { files: ['src/a.ts'], symbols: ['fa'] },
    claims: [],
    relations: [
      { id: 'rel_ab', type: 'imports', target: 'node_b', certainty: 'known', evidence: [ev('src/a.ts', './b.js')] },
      { id: 'rel_ae', type: 'imports', target: 'node_ext', certainty: 'known', evidence: [ev('src/a.ts', 'pkg')] },
    ],
  },
  { id: 'node_b', slug: 'src-b-ts', kind: 'module', title: 'src/b.ts', scope: { files: ['src/b.ts'] }, claims: [], relations: [] },
  {
    id: 'node_c',
    slug: 'src-c-ts',
    kind: 'module',
    title: 'src/c.ts',
    scope: { files: ['src/c.ts'] },
    claims: [],
    relations: [{ id: 'rel_ca', type: 'imports', target: 'node_a', certainty: 'known', evidence: [ev('src/c.ts', './a.js')] }],
  },
  { id: 'node_ext', slug: 'pkg', kind: 'external', title: 'pkg', claims: [], relations: [] },
];

describe('contextFor', () => {
  it('selects the target file, its neighbors, and parent views with reasons', () => {
    const r = contextFor(nodes, ['src/a.ts'], 100000);
    const byId = new Map(r.included.map((s) => [s.node.id, s.reason]));
    expect(byId.get('node_a')).toContain('target');
    expect(byId.get('node_b')).toContain('imported by');
    expect(byId.get('node_ext')).toContain('imported by');
    expect(byId.get('node_c')).toContain('imports the requested file');
    expect(byId.get('node_dir')).toContain('parent view');
    expect(byId.get('node_root')).toContain('repository');
    expect(r.omitted).toHaveLength(0);
  });

  it('respects the token budget, omitting lower-ranked nodes and explaining why', () => {
    const full = contextFor(nodes, ['src/a.ts'], 100000);
    const firstTwoTokens = full.included[0]!.tokens + full.included[1]!.tokens;
    const capped = contextFor(nodes, ['src/a.ts'], firstTwoTokens);
    expect(capped.included).toHaveLength(2);
    expect(capped.used_tokens).toBeLessThanOrEqual(firstTwoTokens);
    expect(capped.omitted.length).toBeGreaterThan(0);
    // the target is ranked first, so it survives any budget that fits at least it
    expect(capped.included[0]!.node.id).toBe('node_a');
  });

  it('is a hard budget: a budget too small for the target includes nothing and never exceeds', () => {
    const r = contextFor(nodes, ['src/a.ts'], 1);
    expect(r.included).toHaveLength(0);
    expect(r.used_tokens).toBe(0);
    expect(r.used_tokens).toBeLessThanOrEqual(r.budget);
    expect(r.omitted.some((o) => o.id === 'node_a')).toBe(true); // target reported as omitted
  });

  it('included entries carry the full evidence-backed node payload', () => {
    const r = contextFor(nodes, ['src/a.ts'], 100000);
    const target = r.included.find((s) => s.node.id === 'node_a')!;
    expect(target.node.relations[0]!.evidence?.[0]!.path).toBe('src/a.ts');
    expect(target.node.scope?.symbols).toEqual(['fa']);
  });
});

describe('impactFor', () => {
  it('includes the seed and the transitive closure of importers', () => {
    const r = impactFor(nodes, ['src/b.ts']);
    const ids = new Set(r.impacted.map((e) => e.id));
    expect(ids.has('node_b')).toBe(true); // seed (module) + dir both scope src/b.ts
    expect(ids.has('node_dir')).toBe(true);
    expect(ids.has('node_a')).toBe(true); // imports b
    expect(ids.has('node_c')).toBe(true); // imports a -> transitively b
    expect(ids.has('node_root')).toBe(true); // parent view
    expect(ids.has('node_ext')).toBe(false); // unrelated external
  });
});

describe('evidenceFor', () => {
  it('resolves a relation id to its evidence', () => {
    const r = evidenceFor(nodes, 'rel_ab');
    expect(r.found).toBe(true);
    expect(r.matched).toBe('relation');
    expect(r.evidence[0]!.path).toBe('src/a.ts');
    expect(r.evidence[0]!.symbol).toBe('./b.js');
  });

  it('resolves a node id to the union of its claim + relation evidence', () => {
    const r = evidenceFor(nodes, 'node_a');
    expect(r.matched).toBe('node');
    expect(r.evidence).toHaveLength(2);
  });

  it('reports not found for an unknown id', () => {
    expect(evidenceFor(nodes, 'node_missing').found).toBe(false);
  });
});
