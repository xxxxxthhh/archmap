import { describe, expect, it } from 'vitest';
import type { Evidence, Node } from '../src/model/types.js';
import { searchArchitecture } from '../src/query/search.js';
import { workItemsFor } from '../src/query/work-items.js';
import type { StatusResult } from '../src/scan/status.js';

const evidence = (path: string): Evidence => ({
  repository: 'local',
  commit: 'working-tree',
  path,
  analyzer: 'typescript',
  analyzer_version: '0.1.0',
  blob_hash: 'sha256:blob',
  extract_hash: 'sha256:extract',
});

const nodes: Node[] = [
  {
    id: 'node_root',
    slug: 'repository',
    kind: 'system',
    title: 'Example Repository',
    claims: [],
    relations: [],
  },
  {
    id: 'node_auth',
    slug: 'auth-service',
    kind: 'module',
    title: 'Authentication Service',
    scope: { files: ['src/auth/service.ts'] },
    claims: [
      {
        id: 'claim_auth',
        type: 'inference',
        text: 'Primary session verification boundary',
        status: 'active',
        confidence: 0.8,
        provenance: {
          actor: 'agent',
          model: 'model-1',
          created_at: '2026-07-14T00:00:00Z',
        },
        evidence: [evidence('src/auth/service.ts')],
      },
    ],
    relations: [
      {
        id: 'rel_auth_store',
        type: 'reads',
        target: 'node_store',
        certainty: 'partial',
        provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
        evidence: [evidence('src/auth/service.ts')],
      },
    ],
  },
  {
    id: 'node_store',
    slug: 'session-store',
    kind: 'store',
    title: 'Session Store',
    scope: { files: ['src/session/store.ts'] },
    claims: [],
    relations: [],
  },
];

describe('searchArchitecture', () => {
  it.each([
    ['AUTH-SERVICE', 'slug'],
    ['authentication service', 'title'],
    ['auth/service', 'scope.files'],
    ['verification boundary', 'claims.text'],
  ] as const)('finds deterministic exact/substring matches for %s', (query, field) => {
    const result = searchArchitecture(nodes, query);
    expect(result.found).toBe(true);
    expect(result.matches.some((match) => match.matched_fields.includes(field))).toBe(true);
  });

  it('sorts by stable node id and preserves tracked claim/relation provenance and evidence', () => {
    const result = searchArchitecture(nodes, 's');
    expect(result.matches.map((match) => match.node.id)).toEqual(
      result.matches.map((match) => match.node.id).slice().sort(),
    );
    const auth = result.matches.find((match) => match.node.id === 'node_auth')!;
    expect(auth.node.claims[0]!.provenance).toEqual(nodes[1]!.claims[0]!.provenance);
    expect(auth.node.claims[0]!.evidence).toEqual(nodes[1]!.claims[0]!.evidence);
    expect(auth.node.relations[0]!.provenance).toEqual(nodes[1]!.relations[0]!.provenance);
  });

  it('returns an explicit stable not-found result', () => {
    expect(searchArchitecture(nodes, 'definitely absent')).toEqual({
      query: 'definitely absent',
      found: false,
      matches: [],
    });
  });
});

describe('workItemsFor', () => {
  const status: StatusResult = {
    scanned: true,
    clean: false,
    base_commit: 'abc123',
    dirty: false,
    diff: {
      added: [],
      modified: ['src/auth/service.ts'],
      deleted: [],
      renamed: [],
      unchanged: 1,
    },
    drift: ['snapshot-metadata'],
    stale_nodes: ['node_auth', 'node_root'],
    file_count: 2,
    node_count: 3,
  };

  it('uses status membership exactly and keeps structured file/model-drift reasons', () => {
    const result = workItemsFor(nodes, status);
    expect(result.items.map((item) => item.node.id)).toEqual(status.stale_nodes);
    for (const item of result.items) {
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item.reasons.some((reason) => reason.kind === 'modified')).toBe(true);
      expect(item.reasons.some((reason) => reason.kind === 'model-drift')).toBe(true);
    }
  });

  it('preserves enriched node data and hard-caps contextual evidence with omitted accounting', () => {
    const result = workItemsFor(nodes, status, 1);
    const auth = result.items.find((item) => item.node.id === 'node_auth')!;
    expect(auth.node.claims).toEqual(nodes[1]!.claims);
    expect(auth.node.relations).toEqual(nodes[1]!.relations);
    expect(auth.evidence_bundle.used_tokens).toBeLessThanOrEqual(1);
    expect(auth.evidence_bundle.included).toHaveLength(0);
    expect(auth.evidence_bundle.omitted_count).toBeGreaterThan(0);
    expect(auth.evidence_bundle.omitted_reason).toBe('budget-exceeded');
  });
});
