import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrackedBaseline } from '../src/scan/baseline.js';
import { projectModel } from '../src/render/project.js';
import { readabilityProbe, MAX_READABLE_NODES } from '../src/render/probe.js';
import type { Node } from '../src/model/types.js';
import type { ViewDefinition } from '../src/views/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'viewer-repo');

function fixtureNodes(): Node[] {
  const baseline = readTrackedBaseline(FIXTURE);
  if (!baseline) throw new Error('viewer-repo fixture is not scanned');
  return baseline.nodes;
}

const view = (v: Partial<ViewDefinition>): ViewDefinition => ({ schema_version: 1, id: 'test', ...v });

function scopedFixtureNodes(nodes: Node[]): Node[] {
  const paths = new Map([
    ['node_api', 'src/api/index.ts'],
    ['node_api_handlers', 'src/api/handlers.ts'],
    ['node_worker', 'worker/main.ts'],
    ['node_worker_jobs', 'worker/jobs.ts'],
  ]);
  return nodes.map((node) => {
    const path = paths.get(node.id);
    return path ? { ...node, scope: { files: [path] } } : node;
  });
}

describe('projectModel', () => {
  const nodes = fixtureNodes();

  it('projects every node and edge under the default (unfiltered) view, sorted by id', () => {
    const g = projectModel(nodes, view({}));
    expect(g.stats).toMatchObject({ total_nodes: 7, visible_nodes: 7, collapsed_nodes: 0, total_edges: 7, visible_edges: 7 });
    expect(g.nodes.map((n) => n.id)).toEqual([...g.nodes.map((n) => n.id)].sort());
    expect(g.edges.map((e) => e.id)).toEqual([...g.edges.map((e) => e.id)].sort());
  });

  it('preserves stable node and relation ids', () => {
    const g = projectModel(nodes, view({}));
    expect(g.nodes.map((n) => n.id)).toContain('node_api');
    expect(g.edges.find((e) => e.id === 'rel_api_reads_db')).toMatchObject({ source: 'node_api', target: 'node_db' });
  });

  it('preserves relation certainty without promoting partial/unknown', () => {
    const g = projectModel(nodes, view({}));
    const byId = new Map(g.edges.map((e) => [e.id, e.certainty]));
    expect(byId.get('rel_api_reads_db')).toBe('known');
    expect(byId.get('rel_api_calls_pay')).toBe('partial');
    expect(byId.get('rel_worker_consumes_pay')).toBe('unknown');
  });

  it('preserves claim fact/inference, stale status, and provenance actor', () => {
    const g = projectModel(nodes, view({}));
    const api = g.nodes.find((n) => n.id === 'node_api')!;
    expect(api.claims.find((c) => c.id === 'claim_api_fact')).toMatchObject({ type: 'fact', actor: 'analyzer' });
    expect(api.claims.find((c) => c.id === 'claim_api_role')).toMatchObject({ type: 'inference', actor: 'agent' });
    const worker = g.nodes.find((n) => n.id === 'node_worker')!;
    expect(worker.claims.find((c) => c.id === 'claim_worker_stale')).toMatchObject({ type: 'inference', status: 'stale', actor: 'human' });
  });

  it('carries only safe evidence pointers, never bulk content', () => {
    const g = projectModel(nodes, view({}));
    const ev = g.nodes.find((n) => n.id === 'node_api')!.claims[0]!.evidence[0]!;
    expect(Object.keys(ev).sort()).toEqual(['blob_hash', 'path', 'symbol']);
  });

  it('collapse_below: component hides modules and drops their edges, reducing node count', () => {
    const full = projectModel(nodes, view({}));
    const collapsed = projectModel(nodes, view({ collapse_below: 'component' }));
    expect(collapsed.stats.visible_nodes).toBeLessThan(full.stats.visible_nodes);
    expect(collapsed.stats.collapsed_nodes).toBe(2);
    expect(collapsed.nodes.some((n) => n.kind === 'module')).toBe(false);
    // External/store boundary nodes are never collapsed by depth.
    expect(collapsed.nodes.some((n) => n.kind === 'external')).toBe(true);
    expect(collapsed.nodes.some((n) => n.kind === 'store')).toBe(true);
    // Edges incident to a hidden module are dropped.
    expect(collapsed.edges.some((e) => e.id === 'rel_handlers_imports_api')).toBe(false);
  });

  it('applies node_kinds and edge_types filters', () => {
    const g = projectModel(nodes, view({ include: { node_kinds: ['system', 'component'], edge_types: ['reads'] } }));
    expect(g.nodes.every((n) => n.kind === 'system' || n.kind === 'component')).toBe(true);
    expect(g.edges.every((e) => e.type === 'reads')).toBe(true);
  });

  it('filters to nodes scoped by a matching repository-relative path prefix', () => {
    const g = projectModel(scopedFixtureNodes(nodes), view({ include: { path_prefixes: ['src/api/'] } }));

    expect(g.view.include.path_prefixes).toEqual(['src/api/']);
    expect(g.nodes.map((node) => node.id)).toEqual(['node_api', 'node_api_handlers']);
    expect(g.edges.map((edge) => edge.id)).toEqual(['rel_handlers_imports_api']);
    expect(g.edges.every((edge) =>
      g.nodes.some((node) => node.id === edge.source) && g.nodes.some((node) => node.id === edge.target),
    )).toBe(true);
  });

  it('excludes unscoped and nonmatching nodes when path_prefixes is present', () => {
    const unscoped: Node = {
      id: 'node_unscoped',
      slug: 'unscoped',
      kind: 'external',
      title: 'Unscoped',
      claims: [],
      relations: [],
    };
    const g = projectModel([...scopedFixtureNodes(nodes), unscoped], view({ include: { path_prefixes: ['worker/'] } }));

    expect(g.nodes.map((node) => node.id)).toEqual(['node_worker', 'node_worker_jobs']);
    expect(g.nodes.some((node) => node.id === unscoped.id)).toBe(false);
    expect(g.edges.map((edge) => edge.id)).toEqual(['rel_worker_jobs']);
  });

  it('preserves the existing projection when path_prefixes is absent', () => {
    const g = projectModel(nodes, view({}));
    expect(g.view.include).toEqual({
      node_kinds: ['system', 'component', 'module', 'external', 'store'],
      edge_types: ['calls', 'reads', 'writes', 'imports', 'publishes', 'consumes', 'depends-on'],
    });
    expect(g.stats).toMatchObject({ visible_nodes: 7, visible_edges: 7 });
  });

  it('is deterministic across runs', () => {
    expect(projectModel(nodes, view({}))).toEqual(projectModel(nodes, view({})));
  });
});

describe('readabilityProbe', () => {
  const nodes = fixtureNodes();

  it('passes for the fixture views', () => {
    expect(readabilityProbe(projectModel(nodes, view({}))).ok).toBe(true);
  });

  it('fails closed and requests a dependency decision beyond the node limit', () => {
    const many: Node[] = Array.from({ length: MAX_READABLE_NODES + 1 }, (_, i) => ({
      id: `node_g${i}`,
      slug: `g-${i}`,
      kind: 'component',
      title: `G${i}`,
      claims: [],
      relations: [],
    }));
    const probe = readabilityProbe(projectModel(many, view({})));
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('dependency decision');
  });
});
