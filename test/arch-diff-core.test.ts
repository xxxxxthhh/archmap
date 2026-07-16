import { describe, it, expect } from 'vitest';
import { diffModels, DiffRefError } from '../src/diff/diff.js';
import { StoreError } from '../src/store-errors.js';
import type { Claim, Node, Relation } from '../src/model/types.js';

// --- builders ----------------------------------------------------------------------------

const evidence = () => ({
  repository: 'repo',
  commit: 'c0',
  path: 'a.ts',
  analyzer: 'universal',
  analyzer_version: '1',
  blob_hash: 'b',
  extract_hash: 'e',
});

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id,
  type: 'inference',
  text: `text of ${id}`,
  status: 'active',
  confidence: 0.9,
  provenance: { actor: 'human', created_at: '2024-01-01T00:00:00Z' },
  evidence: [evidence()],
  ...over,
});

const relation = (id: string, over: Partial<Relation> = {}): Relation => ({
  id,
  type: 'calls',
  target: 'n_other',
  certainty: 'partial',
  ...over,
});

const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  slug: id.replace(/_/g, '-'),
  kind: 'component',
  title: `Title ${id}`,
  claims: [],
  relations: [],
  ...over,
});

const diff = (base: Node[], head: Node[]) => diffModels(base, head, 'a'.repeat(40), 'b'.repeat(40));

// --- tests -------------------------------------------------------------------------------

describe('diffModels', () => {
  it('reports an empty diff for identical models regardless of node order', () => {
    const model = [node('n_a'), node('n_b', { claims: [claim('c_x')] })];
    const report = diff(model, [...model].reverse());
    expect(report).toMatchObject({
      schema_version: 1,
      command: 'diff',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      nodes: { added: [], removed: [], changed: [] },
      relations: { added: [], removed: [], changed: [] },
      claims: { added: [], removed: [], changed: [], stale: [] },
    });
  });

  it('partitions nodes into added and removed by stable id', () => {
    const report = diff([node('n_gone')], [node('n_new')]);
    expect(report.nodes.added.map((n) => n.id)).toEqual(['n_new']);
    expect(report.nodes.removed.map((n) => n.id)).toEqual(['n_gone']);
    expect(report.nodes.changed).toEqual([]);
  });

  it('treats a stable-id rename as a change, not remove+add', () => {
    const before = node('n_svc', { slug: 'old-slug', title: 'Old' });
    const after = node('n_svc', { slug: 'new-slug', title: 'New' });
    const report = diff([before], [after]);
    expect(report.nodes.added).toEqual([]);
    expect(report.nodes.removed).toEqual([]);
    expect(report.nodes.changed).toHaveLength(1);
    expect(report.nodes.changed[0]!.before).toMatchObject({ id: 'n_svc', slug: 'old-slug' });
    expect(report.nodes.changed[0]!.after).toMatchObject({ id: 'n_svc', slug: 'new-slug' });
  });

  it('treats a scope move as a change on the same node id', () => {
    const before = node('n_svc', { scope: { files: ['old/x.ts'] } });
    const after = node('n_svc', { scope: { files: ['new/x.ts'] } });
    const report = diff([before], [after]);
    expect(report.nodes.changed.map((c) => c.after.id)).toEqual(['n_svc']);
    expect(report.nodes.added).toEqual([]);
    expect(report.nodes.removed).toEqual([]);
  });

  it('does not report a node as changed when only its claims/relations change', () => {
    const before = node('n_svc');
    const after = node('n_svc', { claims: [claim('c_new')] });
    const report = diff([before], [after]);
    expect(report.nodes.changed).toEqual([]);
    expect(report.claims.added.map((c) => c.id)).toEqual(['c_new']);
  });

  it('partitions relations by id and carries the owning node', () => {
    const before = [node('n_a', { relations: [relation('r_gone')] })];
    const after = [
      node('n_a', { relations: [relation('r_changed', { target: 'n_z' })] }),
      node('n_b', { relations: [relation('r_added')] }),
    ];
    const withBoth = [
      node('n_a', { relations: [relation('r_gone'), relation('r_changed', { target: 'n_y' })] }),
    ];
    const report = diff(withBoth, after);
    expect(report.relations.added.map((r) => r.id)).toEqual(['r_added']);
    expect(report.relations.removed.map((r) => r.id)).toEqual(['r_gone']);
    expect(report.relations.changed.map((c) => c.after.id)).toEqual(['r_changed']);
    expect(report.relations.changed[0]!.after).toMatchObject({ id: 'r_changed', node: 'n_a', target: 'n_z' });
    // `before` is referenced to keep the two-commit shape obvious; it is a superset check only.
    expect(before.length).toBe(1);
  });

  it('routes a claim that goes stale into the stale bucket, not changed', () => {
    const before = [node('n_a', { claims: [claim('c_x', { status: 'active' })] })];
    const after = [node('n_a', { claims: [claim('c_x', { status: 'stale' })] })];
    const report = diff(before, after);
    expect(report.claims.changed).toEqual([]);
    expect(report.claims.stale.map((c) => c.id)).toEqual(['c_x']);
    expect(report.claims.stale[0]!).toMatchObject({ id: 'c_x', node: 'n_a', status: 'stale' });
  });

  it('routes a non-stale claim edit into the changed bucket', () => {
    const before = [node('n_a', { claims: [claim('c_x', { text: 'one' })] })];
    const after = [node('n_a', { claims: [claim('c_x', { text: 'two' })] })];
    const report = diff(before, after);
    expect(report.claims.changed.map((c) => c.after.id)).toEqual(['c_x']);
    expect(report.claims.stale).toEqual([]);
  });

  it('does not treat an already-stale claim edit as a new stale transition', () => {
    const before = [node('n_a', { claims: [claim('c_x', { status: 'stale', text: 'one' })] })];
    const after = [node('n_a', { claims: [claim('c_x', { status: 'stale', text: 'two' })] })];
    const report = diff(before, after);
    expect(report.claims.stale).toEqual([]);
    expect(report.claims.changed.map((c) => c.after.id)).toEqual(['c_x']);
  });

  it('sorts every bucket by id for byte-stable output', () => {
    const base: Node[] = [];
    const head = [node('n_c'), node('n_a'), node('n_b')];
    const report = diff(base, head);
    expect(report.nodes.added.map((n) => n.id)).toEqual(['n_a', 'n_b', 'n_c']);
  });

  it('exposes DiffRefError as a StoreError subclass for CLI mapping', () => {
    expect(new DiffRefError('x')).toBeInstanceOf(StoreError);
  });
});
