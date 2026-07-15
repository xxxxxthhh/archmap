import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runProposalCommand } from '../src/cli/proposal-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { toCanonicalYaml } from '../src/model/canonical.js';
import type { Claim, Evidence, Node, Relation } from '../src/model/types.js';
import {
  applyProposal,
  computeModelHash,
  previewProposal,
  type Proposal,
} from '../src/proposal/index.js';
import { readTrackedBaseline, type TrackedBaseline } from '../src/scan/baseline.js';
import { paths, publishNodes, type PublishHookStep } from '../src/store.js';
import { StorePathError } from '../src/store-errors.js';

const publishRace = vi.hoisted(() => ({ beforePublish: undefined as (() => void) | undefined }));

vi.mock('../src/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store.js')>();
  return {
    ...actual,
    publishNodes(...args: Parameters<typeof actual.publishNodes>) {
      publishRace.beforePublish?.();
      return actual.publishNodes(...args);
    },
  };
});

let repo: string;
const ctx = () => ({ cwd: repo });

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function write(rel: string, content: string): string {
  const absolute = join(repo, rel);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function baseline(): TrackedBaseline {
  const model = readTrackedBaseline(repo);
  if (!model) throw new Error('expected scanned baseline');
  return model;
}

function sourceNode(model = baseline()): Node {
  const found = model.nodes.find((node) => node.scope?.files?.includes('src/a.ts'));
  if (!found) throw new Error('expected source node');
  return found;
}

function firstEvidence(model = baseline()): Evidence {
  for (const node of model.nodes) {
    for (const claim of node.claims) if (claim.evidence[0]) return claim.evidence[0];
    for (const relation of node.relations) if (relation.evidence?.[0]) return relation.evidence[0];
  }
  throw new Error('expected evidence');
}

function agentClaim(model = baseline(), id = 'claim_applied'): Claim {
  return {
    id,
    type: 'inference',
    text: `Applied agent enrichment ${id}`,
    status: 'active',
    confidence: 0.75,
    provenance: { actor: 'agent', model: 'test-model', created_at: '2026-07-14T00:00:00Z' },
    evidence: [firstEvidence(model)],
  };
}

function proposal(
  operations: Proposal['operations'],
  model = baseline(),
): Proposal {
  return {
    proposal_schema_version: 1,
    base_commit: model.snapshot.base_commit,
    model_hash: computeModelHash(model),
    operations,
  };
}

function addClaimProposal(id = 'claim_applied', model = baseline()): Proposal {
  return proposal([
    {
      op: 'add',
      target: { class: 'claim', node_id: sourceNode(model).id },
      value: agentClaim(model, id),
    },
  ], model);
}

function nodePath(node = sourceNode()): string {
  return join(paths.nodesDir(repo), `${node.id}.yaml`);
}

function rewriteNode(node: Node): void {
  writeFileSync(nodePath(node), toCanonicalYaml({ schema_version: 1, ...node }));
}

function inventory(options: { excludeNodes?: boolean; excludeCache?: boolean } = {}): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const rel = relative(repo, path);
      if (options.excludeNodes && (rel === '.archmap/nodes' || rel.startsWith('.archmap/nodes/'))) continue;
      if (options.excludeCache && (rel === '.archmap/cache' || rel.startsWith('.archmap/cache/'))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  walk(repo);
  return files.sort().map((path) => {
    const bytes = lstatSync(path).isSymbolicLink()
      ? `link:${readFileSync(path).toString('base64')}`
      : readFileSync(path).toString('base64');
    return [relative(repo, path), bytes];
  });
}

function trackedInventory(): Array<[string, string]> {
  return inventory({ excludeCache: true });
}

function addHumanClaim(): Claim {
  const model = baseline();
  const node = structuredClone(sourceNode(model));
  const claim: Claim = {
    id: 'claim_human_decision',
    type: 'inference',
    text: 'Human decision',
    status: 'active',
    confidence: 1,
    provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
    evidence: [firstEvidence(model)],
  };
  node.claims.push(claim);
  rewriteNode(node);
  baseline();
  return claim;
}

beforeEach(() => {
  publishRace.beforePublish = undefined;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-proposal-apply-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/b.ts', 'export const b = 1;\n');
  write('src/a.ts', "import { b } from './b.js';\nexport const a = b + 1;\n");
  git('add', '-A');
  git('commit', '-m', 'fixture');
  runInit([], ctx());
  runScanCommand([], ctx());
});

afterEach(() => {
  publishRace.beforePublish = undefined;
  rmSync(repo, { recursive: true, force: true });
});

describe('proposal apply public behavior', () => {
  it('applies canonical node enrichment, resolves evidence, becomes stale, and survives rescan', () => {
    const input = addClaimProposal();
    const untouchedBefore = inventory({ excludeNodes: true, excludeCache: true });
    const snapshotBefore = readFileSync(paths.snapshot(repo), 'utf8');

    const applied = applyProposal(repo, input);
    expect(applied).toMatchObject({
      verdict: 'applied',
      cache_refreshed: true,
      errors: [],
      conflicts: [],
      warnings: [],
    });
    expect(applied.changed_paths).toEqual([`.archmap/nodes/${sourceNode().id}.yaml`]);
    expect(readFileSync(paths.snapshot(repo), 'utf8')).toBe(snapshotBefore);
    expect(inventory({ excludeNodes: true, excludeCache: true })).toEqual(untouchedBefore);

    const evidence = runEvidenceCommand(['claim_applied', '--json'], ctx());
    expect(evidence.exitCode).toBe(0);
    expect(JSON.parse(evidence.stdout)).toMatchObject({ target: 'claim_applied', matched: 'claim', found: true });
    expect(sourceNode().claims.find((claim) => claim.id === 'claim_applied')?.provenance.actor).toBe('agent');

    const repeated = applyProposal(repo, input);
    expect(repeated.verdict).toBe('invalid');
    expect(repeated.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));

    const scan = runScanCommand([], ctx());
    expect(scan.exitCode).toBe(0);
    expect(sourceNode().claims.some((claim) => claim.id === 'claim_applied')).toBe(true);
  });

  it('exposes deterministic JSON/exit codes and rejects apply-only unknown flags', () => {
    write('proposal.yaml', toCanonicalYaml(addClaimProposal('claim_cli_apply')));
    const applied = runProposalCommand('apply', ['proposal.yaml', '--json'], ctx());
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      schema_version: 1,
      command: 'proposal apply',
      verdict: 'applied',
      cache_refreshed: true,
    });

    const usage = runProposalCommand('apply', ['proposal.yaml', '--approve', '--json'], ctx());
    expect(usage.exitCode).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({ schema_version: 1 });
    const unknown = runProposalCommand('apply', ['proposal.yaml', '--jso', '--json'], ctx());
    expect(unknown.exitCode).toBe(2);
  });

  it('rejects no-op projections so every successful proposal becomes stale on replay', () => {
    const model = baseline();
    const claim = agentClaim(model, 'claim_existing');
    const node = structuredClone(sourceNode(model));
    node.claims.push(claim);
    rewriteNode(node);
    const current = baseline();
    const input = proposal([{
      op: 'replace',
      target: { class: 'claim', node_id: node.id, id: claim.id, field: 'status' },
      value: 'active',
    }], current);
    const before = trackedInventory();
    expect(applyProposal(repo, input)).toMatchObject({ verdict: 'invalid' });
    expect(trackedInventory()).toEqual(before);
  });
});

describe('validate-to-publish baseline binding', () => {
  it('applies when the validated canonical baseline is unchanged', () => {
    const result = applyProposal(repo, addClaimProposal('claim_bound_positive'));
    expect(result.verdict).toBe('applied');
    expect(sourceNode().claims.some((claim) => claim.id === 'claim_bound_positive')).toBe(true);
  });

  it('refuses semantic snapshot drift after validation and preserves the newer snapshot bytes', () => {
    const input = addClaimProposal('claim_lost_snapshot_race');
    let concurrentSnapshot = '';
    let concurrentInventory: Array<[string, string]> = [];
    publishRace.beforePublish = () => {
      const snapshot = parseYaml(readFileSync(paths.snapshot(repo), 'utf8')) as Record<string, unknown>;
      snapshot.dirty = !(snapshot.dirty as boolean);
      concurrentSnapshot = toCanonicalYaml(snapshot);
      writeFileSync(paths.snapshot(repo), concurrentSnapshot);
      concurrentInventory = inventory();
      publishRace.beforePublish = undefined;
    };

    const result = applyProposal(repo, input);
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
    expect(result.changed_paths).toEqual([]);
    expect(readFileSync(paths.snapshot(repo), 'utf8')).toBe(concurrentSnapshot);
    expect(inventory()).toEqual(concurrentInventory);
    expect(sourceNode().claims.some((claim) => claim.id === 'claim_lost_snapshot_race')).toBe(false);
  });

  it('refuses valid node drift after validation without overwriting the concurrent enrichment', () => {
    const input = addClaimProposal('claim_lost_node_race');
    let concurrentInventory: Array<[string, string]> = [];
    publishRace.beforePublish = () => {
      const model = baseline();
      const node = structuredClone(sourceNode(model));
      node.claims.push(agentClaim(model, 'claim_concurrent_after_validation'));
      rewriteNode(node);
      concurrentInventory = inventory();
      publishRace.beforePublish = undefined;
    };

    const result = applyProposal(repo, input);
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
    expect(result.changed_paths).toEqual([]);
    expect(inventory()).toEqual(concurrentInventory);
    const stored = sourceNode();
    expect(stored.claims.some((claim) => claim.id === 'claim_concurrent_after_validation')).toBe(true);
    expect(stored.claims.some((claim) => claim.id === 'claim_lost_node_race')).toBe(false);
  });
});

describe('exact approval set', () => {
  it('refuses missing, extra, duplicate, unknown/stale approvals and accepts only the exact set', () => {
    const human = addHumanClaim();
    const model = baseline();
    const input = proposal([
      {
        op: 'replace',
        target: { class: 'claim', node_id: sourceNode(model).id, id: human.id, field: 'status' },
        value: 'stale',
      },
      {
        op: 'add',
        target: { class: 'claim', node_id: sourceNode(model).id },
        value: agentClaim(model, 'claim_approved_agent'),
      },
    ], model);
    const preview = previewProposal(input, model);
    expect(preview.verdict).toBe('requires-approval');
    const id = preview.conflicts[0]!.id;

    const cases = [
      [],
      [id, 'conflict_stale_000000000000'],
      [id, id],
      ['conflict_unknown_000000000000'],
    ];
    for (const approvals of cases) {
      const before = trackedInventory();
      const refused = applyProposal(repo, input, { approvals });
      expect(refused.verdict).toBe('requires-approval');
      expect(refused.errors).toContainEqual(expect.objectContaining({ code: 'approval-set' }));
      expect(refused.conflicts.map((conflict) => conflict.id)).toEqual([id]);
      expect(trackedInventory()).toEqual(before);
    }

    const applied = applyProposal(repo, input, { approvals: [id] });
    expect(applied.verdict).toBe('applied');
    const stored = sourceNode().claims.find((claim) => claim.id === human.id)!;
    expect(stored.status).toBe('stale');
    expect(stored.provenance.actor).toBe('human');
    expect(sourceNode().claims.find((claim) => claim.id === 'claim_approved_agent')?.provenance.actor).toBe('agent');
  });

  it('enforces the same exact set through repeated public CLI --approve options', () => {
    const human = addHumanClaim();
    const model = baseline();
    const input = proposal([{
      op: 'replace',
      target: { class: 'claim', node_id: sourceNode(model).id, id: human.id, field: 'status' },
      value: 'rejected',
    }], model);
    write('approval.yaml', toCanonicalYaml(input));
    const id = previewProposal(input, model).conflicts[0]!.id;
    for (const args of [
      ['approval.yaml', '--json'],
      ['approval.yaml', '--approve', id, '--approve', id, '--json'],
      ['approval.yaml', '--approve=conflict_stale', '--json'],
    ]) {
      const before = trackedInventory();
      const result = runProposalCommand('apply', args, ctx());
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'requires-approval' });
      expect(trackedInventory()).toEqual(before);
    }
    const applied = runProposalCommand('apply', ['approval.yaml', '--approve', id, '--json'], ctx());
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ verdict: 'applied' });
  });

  it('rejects any approval for a conflict-free proposal', () => {
    const before = trackedInventory();
    const result = applyProposal(repo, addClaimProposal(), { approvals: ['conflict_extra'] });
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'approval-set' }));
    expect(trackedInventory()).toEqual(before);
  });
});

describe('live baseline and apply-internal authorization', () => {
  it('refuses same-commit node drift as stale with zero tracked byte changes', () => {
    const input = addClaimProposal();
    const model = baseline();
    const node = structuredClone(sourceNode(model));
    node.claims.push(agentClaim(model, 'claim_concurrent'));
    rewriteNode(node);
    const before = trackedInventory();
    const result = applyProposal(repo, input);
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
    expect(trackedInventory()).toEqual(before);
  });

  it('refuses same-commit snapshot drift as stale with zero tracked byte changes', () => {
    const input = addClaimProposal();
    const snapshot = parseYaml(readFileSync(paths.snapshot(repo), 'utf8')) as Record<string, unknown>;
    snapshot.excluded_counts = { ...(snapshot.excluded_counts as object), secret: 1 };
    writeFileSync(paths.snapshot(repo), toCanonicalYaml(snapshot));
    const before = trackedInventory();
    const result = applyProposal(repo, input);
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
    expect(trackedInventory()).toEqual(before);
  });

  it('rechecks fact, known relation, and structural prohibitions for direct callers', () => {
    const model = baseline();
    const owner = sourceNode(model);
    const other = model.nodes.find((node) => node.id !== owner.id)!;
    const fact = { ...agentClaim(model, 'claim_forbidden_fact'), type: 'fact' as const };
    const known: Relation = {
      id: 'rel_forbidden_known',
      type: 'depends-on',
      target: other.id,
      certainty: 'known',
      provenance: { actor: 'agent', model: 'test-model', created_at: '2026-07-14T00:00:00Z' },
      evidence: [firstEvidence(model)],
    };
    const inputs: Proposal[] = [
      proposal([{ op: 'add', target: { class: 'claim', node_id: owner.id }, value: fact }], model),
      proposal([{ op: 'add', target: { class: 'relation', node_id: owner.id }, value: known }], model),
      proposal([{ op: 'replace', target: { class: 'node', node_id: owner.id }, value: { title: 'x' } }], model),
    ];
    const before = trackedInventory();
    for (const input of inputs) expect(applyProposal(repo, input).verdict).toBe('forbidden');
    expect(trackedInventory()).toEqual(before);
  });

  it('rejects invalid projected evidence before the write seam', () => {
    const model = baseline();
    const claim = agentClaim(model, 'claim_bad_projection');
    claim.evidence[0] = { ...claim.evidence[0]!, blob_hash: 'sha256:not-the-live-blob' };
    const before = trackedInventory();
    const result = applyProposal(repo, proposal([{
      op: 'add', target: { class: 'claim', node_id: sourceNode(model).id }, value: claim,
    }], model));
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'evidence-mismatch' }));
    expect(trackedInventory()).toEqual(before);
  });

  it('rejects path-escape-shaped direct objects at schema authorization before writes', () => {
    const model = baseline();
    const input = {
      ...addClaimProposal('claim_escape', model),
      operations: [{
        op: 'add',
        target: { class: 'claim', node_id: '../../outside' },
        value: agentClaim(model, 'claim_escape'),
      }],
    };
    const before = trackedInventory();
    expect(applyProposal(repo, input)).toMatchObject({ verdict: 'invalid' });
    expect(trackedInventory()).toEqual(before);
  });

  it('returns a schema verdict before touching an invalid live baseline', () => {
    writeFileSync(paths.snapshot(repo), 'schema_version: 999\n');
    expect(applyProposal(repo, {})).toMatchObject({
      verdict: 'invalid',
      errors: [expect.objectContaining({ code: 'schema' })],
    });
  });
});

describe('shared tracked transaction fault matrix', () => {
  it('rolls back byte-identically before/after the first write and across cleanup/replacement faults', () => {
    const model = baseline();
    const projected = structuredClone(model.nodes);
    projected.find((node) => node.id === sourceNode(model).id)!.claims.push(agentClaim(model));
    const before = inventory();
    const steps: PublishHookStep[] = [
      'before-first-write',
      'after-first-write',
      'after-node-remove',
      'before-node-write',
      'after-node-write',
    ];
    for (const failAt of steps) {
      expect(() => publishNodes(repo, projected, computeModelHash(model), {
        at: (step) => { if (step === failAt) throw new Error(`fault:${failAt}`); },
      })).toThrow(`fault:${failAt}`);
      expect(inventory()).toEqual(before);
      expect(baseline()).not.toBeNull();
    }
  });

  it('restores bytes and surfaces both errors on a rollback double-fault', () => {
    const model = baseline();
    const projected = structuredClone(model.nodes);
    projected.find((node) => node.id === sourceNode(model).id)!.claims.push(agentClaim(model));
    const before = inventory();
    expect(() => publishNodes(repo, projected, computeModelHash(model), {
      at(step) {
        if (step === 'after-first-write') throw new Error('primary-write-fault');
        if (step === 'before-rollback') throw new Error('rollback-fault');
      },
    })).toThrow(/rollback-fault.*original error: primary-write-fault/);
    expect(inventory()).toEqual(before);
    expect(baseline()).not.toBeNull();
  });

  it('rejects a direct store path escape and restores the canonical node set', () => {
    const model = baseline();
    const projected = structuredClone(model.nodes);
    projected[0]!.id = '../outside';
    const outside = join(repo, '.archmap', 'outside.yaml');
    const before = inventory();
    expect(() => publishNodes(repo, projected, computeModelHash(model))).toThrow(StorePathError);
    expect(inventory()).toEqual(before);
    expect(() => readFileSync(outside)).toThrow();
  });

  it('fails before mutation on a read-only canonical node target', () => {
    const path = nodePath();
    const before = inventory();
    chmodSync(path, 0o444);
    try {
      expect(() => applyProposal(repo, addClaimProposal())).toThrow(StorePathError);
      expect(inventory()).toEqual(before);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it('fails closed on a wrong-type canonical node path', () => {
    const path = nodePath();
    rmSync(path);
    mkdirSync(path);
    const before = inventory();
    expect(() => applyProposal(repo, addClaimProposal())).toThrow(StorePathError);
    expect(inventory()).toEqual(before);
  });

  it('never follows a canonical node symlink outside the repository', () => {
    const path = nodePath();
    const outside = join(tmpdir(), `archmap-outside-${process.pid}-${Date.now()}.yaml`);
    writeFileSync(outside, 'OUTSIDE\n');
    rmSync(path);
    symlinkSync(outside, path);
    const before = inventory();
    try {
      expect(() => applyProposal(repo, addClaimProposal())).toThrow(StorePathError);
      expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE\n');
      expect(inventory()).toEqual(before);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('keeps a valid tracked publish when disposable cache refresh fails, then rebuilds it', () => {
    const input = addClaimProposal('claim_cache_failure');
    const untouchedBefore = inventory({ excludeNodes: true, excludeCache: true });
    rmSync(paths.cacheDir(repo), { recursive: true, force: true });
    writeFileSync(paths.cacheDir(repo), 'wrong type\n');

    const result = applyProposal(repo, input);
    expect(result).toMatchObject({
      verdict: 'applied',
      cache_refreshed: false,
      warnings: [{ code: 'cache-refresh' }],
    });
    expect(sourceNode().claims.some((claim) => claim.id === 'claim_cache_failure')).toBe(true);
    expect(inventory({ excludeNodes: true, excludeCache: true })).toEqual(untouchedBefore);

    rmSync(paths.cacheDir(repo));
    const rebuilt = runScanCommand(['--changed'], ctx());
    expect(rebuilt.exitCode).toBe(0);
    expect(readFileSync(paths.index(repo), 'utf8')).toContain('fingerprint');
  });
});
