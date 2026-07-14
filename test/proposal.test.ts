import { describe, expect, it } from 'vitest';
import { toCanonicalYaml } from '../src/model/canonical.js';
import type { Claim, Evidence, Node, Relation } from '../src/model/types.js';
import {
  computeModelHash,
  previewProposal,
  validateProposal,
  type Proposal,
} from '../src/proposal/index.js';
import type { TrackedBaseline } from '../src/scan/baseline.js';

const evidence: Evidence = {
  repository: 'local',
  commit: 'abc123',
  path: 'src/a.ts',
  symbol: 'a',
  analyzer: 'typescript',
  analyzer_version: '0.1.0',
  blob_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  extract_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

const agentClaim: Claim = {
  id: 'claim_agent',
  type: 'inference',
  text: 'Agent-authored interpretation',
  status: 'active',
  confidence: 0.8,
  provenance: { actor: 'agent', model: 'test-model', created_at: '2026-07-14T00:00:00Z' },
  evidence: [evidence],
};

const humanClaim: Claim = {
  ...agentClaim,
  id: 'claim_human',
  text: 'Human-authored interpretation',
  provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
};

const agentRelation: Relation = {
  id: 'rel_agent',
  type: 'depends-on',
  target: 'node_b',
  certainty: 'partial',
  provenance: { actor: 'agent', model: 'test-model', created_at: '2026-07-14T00:00:00Z' },
};

function baseline(): TrackedBaseline {
  const nodes: Node[] = [
    {
      id: 'node_a',
      slug: 'a',
      kind: 'module',
      title: 'A',
      scope: { files: ['src/a.ts'] },
      claims: [structuredClone(agentClaim), structuredClone(humanClaim)],
      relations: [structuredClone(agentRelation)],
    },
    {
      id: 'node_b',
      slug: 'b',
      kind: 'module',
      title: 'B',
      scope: { files: ['src/b.ts'] },
      claims: [],
      relations: [],
    },
  ];
  return {
    snapshot: {
      schema_version: 1,
      base_commit: 'abc123',
      dirty: false,
      capabilities: [{ id: 'typescript', version: '0.1.0', status: 'supported' }],
      files: [
        { path: 'src/a.ts', blob_hash: evidence.blob_hash, size: 1, category: 'source' },
        {
          path: 'src/b.ts',
          blob_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          size: 1,
          category: 'source',
        },
      ],
      excluded_counts: {
        'excluded-dir': 0,
        secret: 0,
        'too-large': 0,
        binary: 0,
        symlink: 0,
      },
    },
    nodes,
  };
}

function proposal(model: TrackedBaseline, operations: Proposal['operations']): Proposal {
  return {
    proposal_schema_version: 1,
    base_commit: model.snapshot.base_commit,
    model_hash: computeModelHash(model),
    operations,
  };
}

function addClaimOperation(claim: Claim = { ...agentClaim, id: 'claim_new' }): Proposal['operations'][number] {
  return { op: 'add', target: { class: 'claim', node_id: 'node_a' }, value: claim };
}

describe('proposal schema and baseline fingerprint', () => {
  it('rejects malformed, empty, unknown, and unsupported proposals before projection', () => {
    const model = baseline();
    const cases: unknown[] = [
      null,
      {},
      { proposal_schema_version: 2, base_commit: 'abc123', model_hash: computeModelHash(model), operations: [] },
      { proposal_schema_version: 1, base_commit: 'abc123', model_hash: computeModelHash(model), operations: [] },
      {
        proposal_schema_version: 1,
        base_commit: 'abc123',
        model_hash: computeModelHash(model),
        operations: [{ op: 'launch', target: { class: 'node', node_id: 'node_a' } }],
      },
      { ...proposal(model, [addClaimOperation()]), extra: true },
      proposal(model, [addClaimOperation({ ...agentClaim, id: 'claim_no_evidence', evidence: [] })]),
      proposal(model, [
        { op: 'add', target: { class: 'claim', node_id: 'node_a' }, value: 'not-a-claim' },
      ]),
    ];

    for (const input of cases) {
      const result = previewProposal(input, model);
      expect(result.verdict).toBe('invalid');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('diff');
    }
  });

  it('hashes the canonical full snapshot and id-sorted node baseline', () => {
    const model = baseline();
    const reversed = { snapshot: structuredClone(model.snapshot), nodes: [...model.nodes].reverse() };
    expect(computeModelHash(reversed)).toBe(computeModelHash(model));

    const enriched = structuredClone(model);
    enriched.nodes[0]!.claims[0]!.text = 'same commit, different human or agent enrichment';
    expect(computeModelHash(enriched)).not.toBe(computeModelHash(model));

    const rescanned = structuredClone(model);
    rescanned.snapshot.files[0]!.blob_hash = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    expect(computeModelHash(rescanned)).not.toBe(computeModelHash(model));
  });

  it('fails closed on stale commit or model hash without a projected payload', () => {
    const model = baseline();
    for (const input of [
      { ...proposal(model, [addClaimOperation()]), base_commit: 'different' },
      { ...proposal(model, [addClaimOperation()]), model_hash: 'sha256:' + '0'.repeat(64) },
    ]) {
      const result = previewProposal(input, model);
      expect(result.verdict).toBe('invalid');
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
      expect(result).not.toHaveProperty('diff');
    }
  });
});

describe('proposal authorization and conflicts', () => {
  it('rejects statically forbidden content before resolving missing owner or target references', () => {
    const model = baseline();
    const fact = { ...agentClaim, id: 'claim_fact_missing_owner', type: 'fact' as const };
    const known = {
      ...agentRelation,
      id: 'rel_known_missing_reference',
      target: 'node_missing',
      certainty: 'known' as const,
      evidence: [evidence],
    };
    const cases: Proposal['operations'][] = [
      [{ ...addClaimOperation(fact), target: { class: 'claim', node_id: 'node_missing' } }],
      [{ op: 'add', target: { class: 'relation', node_id: 'node_missing' }, value: known }],
      [{ op: 'add', target: { class: 'relation', node_id: 'node_a' }, value: known }],
    ];

    for (const operations of cases) {
      const result = validateProposal(proposal(model, operations), model);
      expect(result.verdict).toBe('forbidden');
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'forbidden-content' }));
    }
  });

  it('allows removal only for agent-owned partial/unknown relations', () => {
    const model = baseline();
    model.nodes[0]!.relations.push(
      { ...agentRelation, id: 'rel_agent_unknown', certainty: 'unknown' },
      { ...agentRelation, id: 'rel_agent_known', certainty: 'known', evidence: [evidence] },
      {
        ...agentRelation,
        id: 'rel_analyzer_partial',
        provenance: { actor: 'analyzer', created_at: '2026-07-14T00:00:00Z' },
      },
    );

    for (const relationId of ['rel_agent', 'rel_agent_unknown']) {
      const result = validateProposal(
        proposal(model, [
          { op: 'remove', target: { class: 'relation', node_id: 'node_a', id: relationId } },
        ]),
        model,
      );
      expect(result.verdict, relationId).toBe('valid');
    }

    for (const relationId of ['rel_agent_known', 'rel_analyzer_partial']) {
      const result = validateProposal(
        proposal(model, [
          { op: 'remove', target: { class: 'relation', node_id: 'node_a', id: relationId } },
        ]),
        model,
      );
      expect(result.verdict, relationId).toBe('forbidden');
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'forbidden-content' }));
    }
  });

  it('forbids every mutation verb against non-agent-writable target classes', () => {
    const model = baseline();
    const targets = [
      { class: 'node' as const, node_id: 'node_a' },
      { class: 'evidence' as const, node_id: 'node_a', id: 'claim_agent' },
      { class: 'capability' as const, id: 'typescript' },
      { class: 'snapshot' as const },
      { class: 'project' as const },
    ];
    for (const op of ['add', 'replace', 'remove'] as const) {
      for (const target of targets) {
        const operation = op === 'remove' ? { op, target } : { op, target, value: {} };
        const result = validateProposal(proposal(model, [operation]), model);
        expect(result.verdict, `${op} ${target.class}`).toBe('forbidden');
        expect(result.errors).toContainEqual(expect.objectContaining({ code: 'forbidden-target' }));
      }
    }
    const nodeCreate = validateProposal(
      proposal(model, [{ op: 'add', target: { class: 'node', node_id: 'node_new' }, value: {} }]),
      model,
    );
    expect(nodeCreate.verdict).toBe('forbidden');
  });

  it('forbids fact, human/analyzer authorship, known relations, and analyzer-owned status changes', () => {
    const model = baseline();
    const fact = { ...agentClaim, id: 'claim_fact', type: 'fact' as const };
    const analyzer = {
      ...agentClaim,
      id: 'claim_analyzer',
      provenance: { actor: 'analyzer' as const, created_at: '2026-07-14T00:00:00Z' },
    };
    const human = { ...humanClaim, id: 'claim_human_new' };
    const known = { ...agentRelation, id: 'rel_known', certainty: 'known' as const, evidence: [evidence] };
    const humanRelation = {
      ...agentRelation,
      id: 'rel_human_new',
      provenance: { actor: 'human' as const, created_at: '2026-07-14T00:00:00Z' },
    };
    const analyzerRelation = {
      ...agentRelation,
      id: 'rel_analyzer_new',
      provenance: { actor: 'analyzer' as const, created_at: '2026-07-14T00:00:00Z' },
    };
    const analyzerOwned = structuredClone(model);
    analyzerOwned.nodes[0]!.claims.push({ ...fact, provenance: analyzer.provenance });

    const cases = [
      validateProposal(proposal(model, [addClaimOperation(fact)]), model),
      validateProposal(proposal(model, [addClaimOperation(analyzer)]), model),
      validateProposal(proposal(model, [addClaimOperation(human)]), model),
      validateProposal(
        proposal(model, [{ op: 'add', target: { class: 'relation', node_id: 'node_a' }, value: known }]),
        model,
      ),
      validateProposal(
        proposal(model, [{ op: 'add', target: { class: 'relation', node_id: 'node_a' }, value: humanRelation }]),
        model,
      ),
      validateProposal(
        proposal(model, [{ op: 'add', target: { class: 'relation', node_id: 'node_a' }, value: analyzerRelation }]),
        model,
      ),
      validateProposal(
        proposal(analyzerOwned, [
          {
            op: 'replace',
            target: { class: 'claim', node_id: 'node_a', id: 'claim_fact', field: 'status' },
            value: 'stale',
          },
        ]),
        analyzerOwned,
      ),
    ];
    expect(cases.every((result) => result.verdict === 'forbidden')).toBe(true);
  });

  it('requires approval for human and provenance-absent legacy content with stable conflict ids', () => {
    const model = baseline();
    const legacyRelation: Relation = {
      id: 'rel_legacy',
      type: agentRelation.type,
      target: agentRelation.target,
      certainty: agentRelation.certainty,
    };
    model.nodes[0]!.relations.push(
      {
        ...agentRelation,
        id: 'rel_human',
        provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
      },
      legacyRelation,
    );
    const operations: Proposal['operations'] = [
      {
        op: 'replace',
        target: { class: 'claim', node_id: 'node_a', id: 'claim_human', field: 'status' },
        value: 'stale',
      },
      { op: 'remove', target: { class: 'relation', node_id: 'node_a', id: 'rel_human' } },
      { op: 'remove', target: { class: 'relation', node_id: 'node_a', id: 'rel_legacy' } },
    ];
    const first = previewProposal(proposal(model, operations), model);
    const second = previewProposal(proposal(model, operations), model);
    expect(first.verdict).toBe('requires-approval');
    expect(first).toEqual(second);
    expect(first.conflicts).toHaveLength(3);
    expect(new Set(first.conflicts.map((conflict) => conflict.id)).size).toBe(3);
    expect(first).not.toHaveProperty('diff');
  });

  it('rejects nonexistent references, duplicate/colliding ids, and colliding operations', () => {
    const model = baseline();
    const cases: Proposal['operations'][] = [
      [{ ...addClaimOperation(), target: { class: 'claim', node_id: 'node_missing' } }],
      [addClaimOperation({ ...agentClaim, id: 'node_b' })],
      [addClaimOperation(), addClaimOperation()],
      [
        {
          op: 'replace',
          target: { class: 'claim', node_id: 'node_a', id: 'claim_missing', field: 'status' },
          value: 'stale',
        },
      ],
      [
        {
          op: 'add',
          target: { class: 'relation', node_id: 'node_a' },
          value: { ...agentRelation, id: 'rel_missing_target', target: 'node_missing' },
        },
      ],
    ];
    for (const operations of cases) {
      expect(validateProposal(proposal(model, operations), model).verdict).toBe('invalid');
    }
  });
});

describe('proposal pure projection', () => {
  it('previews an evidence-backed agent inference as one exact canonical tracked-node diff', () => {
    const model = baseline();
    const before = structuredClone(model);
    const claim = { ...agentClaim, id: 'claim_new' };
    const result = previewProposal(proposal(model, [addClaimOperation(claim)]), model);
    expect(result.verdict).toBe('valid');
    expect(model).toEqual(before);
    expect(result.diff).toEqual([
      {
        path: '.archmap/nodes/node_a.yaml',
        before: toCanonicalYaml({ schema_version: 1, ...before.nodes[0] }),
        after: toCanonicalYaml({
          schema_version: 1,
          ...before.nodes[0],
          claims: [...before.nodes[0]!.claims, claim],
        }),
      },
    ]);
  });

  it('previews agent claim status and relation add/remove operations deterministically', () => {
    const model = baseline();
    const newRelation: Relation = { ...agentRelation, id: 'rel_new', certainty: 'unknown' };
    const result = previewProposal(
      proposal(model, [
        {
          op: 'replace',
          target: { class: 'claim', node_id: 'node_a', id: 'claim_agent', field: 'status' },
          value: 'stale',
        },
        { op: 'remove', target: { class: 'relation', node_id: 'node_a', id: 'rel_agent' } },
        { op: 'add', target: { class: 'relation', node_id: 'node_b' }, value: newRelation },
      ]),
      model,
    );
    expect(result.verdict).toBe('valid');
    expect(result.diff?.map((entry) => entry.path)).toEqual([
      '.archmap/nodes/node_a.yaml',
      '.archmap/nodes/node_b.yaml',
    ]);
    expect(result.diff?.[0]!.after).toContain('status: stale');
    expect(result.diff?.[0]!.after).not.toContain('rel_agent');
    expect(result.diff?.[1]!.after).toContain('rel_new');
  });

  it('fails projected-manifest evidence checks and never returns a partial diff', () => {
    const model = baseline();
    const badEvidence = { ...evidence, analyzer: 'undeclared' };
    const result = previewProposal(
      proposal(model, [addClaimOperation({ ...agentClaim, id: 'claim_bad', evidence: [badEvidence] })]),
      model,
    );
    expect(result.verdict).toBe('invalid');
    expect(result.errors.some((error) => error.path.includes('/evidence/0'))).toBe(true);
    expect(result).not.toHaveProperty('diff');
  });

  it('rejects evidence paths outside or absent from the tracked snapshot', () => {
    const model = baseline();
    for (const path of ['../secret.txt', '/absolute/secret.txt', 'src/missing.ts']) {
      const result = validateProposal(
        proposal(model, [
          addClaimOperation({ ...agentClaim, id: `claim_${path.length}`, evidence: [{ ...evidence, path }] }),
        ]),
        model,
      );
      expect(result.verdict).toBe('invalid');
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'invalid-evidence-path' }));
    }
  });
});
