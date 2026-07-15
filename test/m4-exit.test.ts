/**
 * M4 exit audit: the model-independent agent update loop and the four PLAN M4 exit criteria,
 * proven end to end through the public MCP tools and CLI proposal commands only.
 *
 * The "agent" here is a deterministic scripted consumer — no model is invoked. It reads stale
 * work and evidence through the MCP query tools, has `propose_update` stamp the live baseline
 * fingerprint, validates through both MCP and the CLI, previews the canonical diff through the
 * CLI, and applies through the MCP transaction. The proposal handlers are thin adapters over
 * the same library the CLI uses, so equivalence and every safety invariant are shared, not
 * duplicated.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/cli/init-command.js';
import { runProposalCommand } from '../src/cli/proposal-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { runWorkItemsCommand } from '../src/cli/work-items-command.js';
import { toCanonicalJson, toCanonicalYaml } from '../src/model/canonical.js';
import type { Claim, Evidence, Node, Relation } from '../src/model/types.js';
import { callTool, type QueryContext } from '../src/mcp/handlers.js';
import { ToolInputError } from '../src/mcp/tools.js';
import { computeModelHash, type Proposal } from '../src/proposal/index.js';
import { readTrackedBaseline, type TrackedBaseline } from '../src/scan/baseline.js';
import { paths, type PublishHookStep } from '../src/store.js';

// A single fault hook the mocked `publishNodes` injects into the real transaction, so faults can
// be driven through the MCP apply seam (callTool -> applyProposal -> publishNodes) itself.
const publishFault = vi.hoisted(() => ({ at: undefined as ((step: PublishHookStep) => void) | undefined }));

vi.mock('../src/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store.js')>();
  return {
    ...actual,
    publishNodes(...args: Parameters<typeof actual.publishNodes>) {
      const [root, nodes, hash, hooks] = args;
      return actual.publishNodes(root, nodes, hash, publishFault.at ? { at: publishFault.at } : hooks);
    },
  };
});

// Each test re-scans the mixed fixture in `beforeEach` (a real adapter pass, Python worker
// included), so both the hook and the tests need a generous budget under full-suite parallelism.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mixed-repo');
const CHANGED = 'pipeline/api.py';
const FIXED_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ArchMap Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'ArchMap Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

let repo: string;
// Proposal input files are written here, outside the repo, so they never enter its byte
// inventory (the CLI accepts external proposal input by design).
let scratch: string;
const repos: string[] = [];
const ctx = (cwd = repo): QueryContext => ({ cwd });

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: FIXED_GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A fresh, deterministically committed and scanned copy of the mixed fixture. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-m4-exit-')));
  cpSync(FIXTURE, dir, { recursive: true });
  rmSync(join(dir, 'golden.manifest.json'), { force: true });
  git(dir, 'init');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'mixed fixture');
  expect(runInit([], ctx(dir)).exitCode).toBe(0);
  expect(runScanCommand([], ctx(dir)).exitCode).toBe(0);
  repos.push(dir);
  return dir;
}

function baseline(cwd = repo): TrackedBaseline {
  const model = readTrackedBaseline(cwd);
  if (!model) throw new Error('expected scanned baseline');
  return model;
}

/** The stale-safe enrichment target: the single-file node for the changed path, with evidence. */
function targetNode(model = baseline()): Node {
  const node = model.nodes.find(
    (candidate) =>
      candidate.scope?.files?.length === 1 &&
      candidate.scope.files.includes(CHANGED) &&
      firstEvidenceOf(candidate) !== undefined,
  );
  if (!node) throw new Error('expected an evidence-bearing single-file node for the changed path');
  return node;
}

function firstEvidenceOf(node: Node): Evidence | undefined {
  for (const claim of node.claims) if (claim.evidence[0]) return claim.evidence[0];
  for (const relation of node.relations) if (relation.evidence?.[0]) return relation.evidence[0];
  return undefined;
}

/** The one deterministic agent claim the scripted consumer authors. */
function agentClaim(evidence: Evidence, id = 'claim_agent_m4_exit'): Claim {
  return {
    id,
    type: 'inference',
    text: 'Agent-reviewed after a source change; behaviour needs revalidation.',
    status: 'active',
    confidence: 0.6,
    provenance: { actor: 'agent', model: 'scripted-consumer', created_at: '2026-07-15T00:00:00Z' },
    evidence: [evidence],
  };
}

function proposalFor(operations: Proposal['operations'], model = baseline()): Proposal {
  return {
    proposal_schema_version: 1,
    base_commit: model.snapshot.base_commit,
    model_hash: computeModelHash(model),
    operations,
  };
}

/** The scripted, model-independent consumer: build an enrichment from MCP work items only. */
function scriptedConsumerOperations(): Proposal['operations'] {
  const workItems = mcpPayload('get_update_work_items') as { items: Array<{ node: Node }> };
  const item = workItems.items
    .filter((entry) => entry.node.scope?.files?.length === 1 && entry.node.scope.files.includes(CHANGED))
    .sort((a, b) => a.node.id.localeCompare(b.node.id))
    .find((entry) => firstEvidenceOf(entry.node) !== undefined);
  if (!item) throw new Error('scripted consumer found no evidence-bearing stale work item');
  return [{ op: 'add', target: { class: 'claim', node_id: item.node.id }, value: agentClaim(firstEvidenceOf(item.node)!) }];
}

/** Call an MCP tool in-process; throws exactly as the handler does (invalid params, faults). */
function mcp(name: string, args: Record<string, unknown> = {}): { ok: true; payload: unknown } | { ok: false; error: string } {
  return callTool(name, args, ctx());
}

function mcpPayload(name: string, args: Record<string, unknown> = {}): unknown {
  const result = mcp(name, args);
  if (!result.ok) throw new Error(`${name} failed closed: ${result.error}`);
  return result.payload;
}

/** The canonical text an MCP tool answers with — the exact bytes the server puts on the wire. */
function mcpText(name: string, args: Record<string, unknown> = {}): string {
  return toCanonicalJson(mcpPayload(name, args));
}

/** Write a proposal to an external scratch file the CLI can load. */
function scratchProposal(name: string, proposal: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(proposal));
  return file;
}

/** A CLI proposal report with only its `schema_version`/`command`/`path` envelope removed. */
function cliProposalDomain(mode: 'validate' | 'preview' | 'apply', proposal: Proposal, approve: string[] = []): string {
  const file = scratchProposal(`proposal-${mode}.json`, proposal);
  const approvals = approve.flatMap((id) => ['--approve', id]);
  const output = runProposalCommand(mode, [file, ...approvals, '--json'], ctx());
  const report = JSON.parse(output.stdout) as Record<string, unknown>;
  delete report.schema_version;
  delete report.command;
  delete report.path;
  return toCanonicalJson(report);
}

function inventory(options: { excludeCache?: boolean } = {}): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      const rel = relative(repo, path);
      if (options.excludeCache && (rel === '.archmap/cache' || rel.startsWith('.archmap/cache/'))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  walk(repo);
  return files.sort().map((path) => [relative(repo, path), readFileSync(path).toString('base64')]);
}

/** Add a human-owned claim to the target node so a status change becomes a decision conflict. */
function addHumanClaim(): { node: Node; claim: Claim } {
  const model = baseline();
  const node = structuredClone(targetNode(model));
  const claim: Claim = {
    id: 'claim_human_decision',
    type: 'inference',
    text: 'Reviewed and accepted by a human operator.',
    status: 'active',
    confidence: 1,
    provenance: { actor: 'human', created_at: '2026-07-15T00:00:00Z' },
    evidence: [firstEvidenceOf(node)!],
  };
  node.claims.push(claim);
  writeFileSync(join(paths.nodesDir(repo), `${node.id}.yaml`), toCanonicalYaml({ schema_version: 1, ...node }));
  baseline();
  return { node, claim };
}

beforeEach(() => {
  publishFault.at = undefined;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-m4-scratch-')));
  repo = makeRepo();
});

afterEach(() => {
  publishFault.at = undefined;
  rmSync(scratch, { recursive: true, force: true });
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('M4 exit: model-independent agent update loop through public seams', () => {
  it('runs propose -> validate (MCP+CLI) -> preview (CLI) -> apply (MCP), then survives rescan', () => {
    // 2-3. A deterministic source change makes the api node stale; the read tools surface it.
    writeFileSync(join(repo, CHANGED), `${readFileSync(join(repo, CHANGED), 'utf8')}\ndef added() -> int:\n    return 1\n`);
    const stale = mcpPayload('list_stale_nodes') as { stale_nodes: string[] };
    expect(stale.stale_nodes.length).toBeGreaterThan(0);

    // 4-5. The scripted consumer builds operations; propose_update stamps the live fingerprint.
    const operations = scriptedConsumerOperations();
    const proposal = mcpPayload('propose_update', { operations }) as Proposal;
    expect(proposal).toMatchObject({
      proposal_schema_version: 1,
      base_commit: baseline().snapshot.base_commit,
      model_hash: computeModelHash(baseline()),
    });

    // 6. Validate through both surfaces: identical domain payload, verdict valid.
    expect(mcpText('validate_proposal', { proposal })).toBe(cliProposalDomain('validate', proposal));
    expect((mcpPayload('validate_proposal', { proposal }) as { verdict: string }).verdict).toBe('valid');

    // 7. Preview the exact canonical diff through the CLI.
    const previewFile = scratchProposal('preview.json', proposal);
    const preview = JSON.parse(runProposalCommand('preview', [previewFile, '--json'], ctx()).stdout) as {
      verdict: string;
      diff: Array<{ path: string }>;
    };
    expect(preview.verdict).toBe('valid');
    expect(preview.diff.map((entry) => entry.path)).toEqual([`.archmap/nodes/${targetNode().id}.yaml`]);

    // 8. Apply the non-conflicting proposal through the MCP transaction.
    const applied = mcpPayload('apply_proposal', { proposal }) as {
      verdict: string;
      changed_paths: string[];
    };
    expect(applied.verdict).toBe('applied');
    expect(applied.changed_paths).toEqual([`.archmap/nodes/${targetNode().id}.yaml`]);

    // 9. The new inference/evidence resolves through the read tools.
    const evidence = mcpPayload('get_evidence', { id: 'claim_agent_m4_exit' }) as { found: boolean; matched?: string };
    expect(evidence).toMatchObject({ found: true, matched: 'claim' });

    // 10. Commit the change and rescan: the agent enrichment survives.
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'source change');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(targetNode().claims.some((claim) => claim.id === 'claim_agent_m4_exit')).toBe(true);

    // 11. Repeat the read workflow: clean, stable, no unexpected tracked diff.
    expect((mcpPayload('project_summary') as { clean: boolean }).clean).toBe(true);
    const tracked = inventory({ excludeCache: true });
    expect(mcpText('get_update_work_items')).toBe(mcpText('get_update_work_items'));
    expect(inventory({ excludeCache: true })).toEqual(tracked);
  });
});

describe('M4 exit criterion 1: deterministic facts are immutable', () => {
  it('rejects fact, analyzer/known relation, and structure edits at validate and apply, writing nothing', () => {
    const model = baseline();
    const node = targetNode(model);
    const other = model.nodes.find((candidate) => candidate.id !== node.id)!;
    const evidence = firstEvidenceOf(node)!;
    const analyzerRelation = [...node.relations].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    expect(analyzerRelation.provenance?.actor === 'analyzer' || analyzerRelation.certainty === 'known').toBe(true);

    const fact: Claim = { ...agentClaim(evidence, 'claim_forbidden_fact'), type: 'fact' };
    const knownRelation: Relation = {
      id: 'rel_forbidden_known',
      type: 'depends-on',
      target: other.id,
      certainty: 'known',
      provenance: { actor: 'agent', model: 'scripted-consumer', created_at: '2026-07-15T00:00:00Z' },
      evidence: [evidence],
    };

    const forbidden: Proposal[] = [
      proposalFor([{ op: 'add', target: { class: 'claim', node_id: node.id }, value: fact }], model),
      proposalFor([{ op: 'add', target: { class: 'relation', node_id: node.id }, value: knownRelation }], model),
      proposalFor([{ op: 'remove', target: { class: 'relation', node_id: node.id, id: analyzerRelation.id } }], model),
      proposalFor([{ op: 'replace', target: { class: 'node', node_id: node.id }, value: { title: 'x' } }], model),
    ];

    const before = inventory({ excludeCache: true });
    for (const proposal of forbidden) {
      // Both surfaces agree on the verdict, byte for byte, at validate.
      const verdict = (mcpPayload('validate_proposal', { proposal }) as { verdict: string }).verdict;
      expect(verdict).toBe('forbidden');
      expect(mcpText('validate_proposal', { proposal })).toBe(cliProposalDomain('validate', proposal));

      // And apply refuses through MCP and the CLI without ever writing.
      expect((mcpPayload('apply_proposal', { proposal }) as { verdict: string }).verdict).toBe('forbidden');
      expect(mcpText('apply_proposal', { proposal })).toBe(cliProposalDomain('apply', proposal));
    }
    expect(inventory({ excludeCache: true })).toEqual(before);
  });
});

describe('M4 exit criterion 2: human decision conflicts require explicit CLI approval', () => {
  it('MCP returns a pending-approval verdict with stable ids and no write; only the CLI can approve', () => {
    const { claim } = addHumanClaim();
    const model = baseline();
    const proposal = proposalFor(
      [{ op: 'replace', target: { class: 'claim', node_id: targetNode(model).id, id: claim.id, field: 'status' }, value: 'stale' }],
      model,
    );

    // Stable conflict id from the read-only validate seam.
    const validated = mcpPayload('validate_proposal', { proposal }) as {
      verdict: string;
      conflicts: Array<{ id: string }>;
    };
    expect(validated.verdict).toBe('requires-approval');
    const conflictId = validated.conflicts[0]!.id;

    // MCP apply cannot approve: it returns a pending-approval verdict with the same ids, no write.
    const before = inventory({ excludeCache: true });
    const applied = mcp('apply_proposal', { proposal });
    expect(applied.ok).toBe(true);
    expect(applied.ok && (applied.payload as { verdict: string }).verdict).toBe('requires-approval');
    expect(applied.ok && (applied.payload as { changed_paths: string[] }).changed_paths).toEqual([]);
    expect(applied.ok && (applied.payload as { conflicts: Array<{ id: string }> }).conflicts.map((c) => c.id)).toEqual([conflictId]);
    expect(inventory({ excludeCache: true })).toEqual(before);

    // The MCP apply conflict verdict equals the CLI's un-approved apply, after envelope stripping.
    expect(applied.ok && toCanonicalJson(applied.payload)).toBe(cliProposalDomain('apply', proposal));

    // There is no approval channel on the tool: an approval-like field is schema-rejected.
    expect(() => mcp('apply_proposal', { proposal, approvals: [conflictId] })).toThrow(ToolInputError);
    expect(() => mcp('apply_proposal', { proposal, approve: conflictId })).toThrow(ToolInputError);
    expect(inventory({ excludeCache: true })).toEqual(before);

    // The CLI applies only with the exact explicit approval set.
    const cliFile = scratchProposal('conflict.json', proposal);
    expect(runProposalCommand('apply', [cliFile, '--json'], ctx()).exitCode).toBe(1);
    expect(inventory({ excludeCache: true })).toEqual(before);
    const cliApplied = runProposalCommand('apply', [cliFile, '--approve', conflictId, '--json'], ctx());
    expect(cliApplied.exitCode).toBe(0);
    expect(JSON.parse(cliApplied.stdout)).toMatchObject({ verdict: 'applied' });
    expect(targetNode().claims.find((c) => c.id === claim.id)?.status).toBe('stale');
  });
});

describe('M4 exit criterion 3: no partial write', () => {
  it('injects a fault at each MCP apply transaction boundary and restores bytes exactly', () => {
    const model = baseline();
    const proposal = proposalFor(
      [{ op: 'add', target: { class: 'claim', node_id: targetNode(model).id }, value: agentClaim(firstEvidenceOf(targetNode(model))!) }],
      model,
    );
    const steps: PublishHookStep[] = [
      'before-first-write',
      'after-first-write',
      'after-node-remove',
      'before-node-write',
      'after-node-write',
    ];
    const before = inventory();
    for (const failAt of steps) {
      publishFault.at = (step) => {
        if (step === failAt) throw new Error(`fault:${failAt}`);
      };
      expect(() => mcp('apply_proposal', { proposal })).toThrow(`fault:${failAt}`);
      publishFault.at = undefined;
      expect(inventory(), `bytes must be restored after a fault at ${failAt}`).toEqual(before);
      expect(readTrackedBaseline(repo)).not.toBeNull();
    }
    // With no fault, the same apply succeeds and changes only the target node file.
    const applied = mcpPayload('apply_proposal', { proposal }) as { verdict: string };
    expect(applied.verdict).toBe('applied');
  });
});

describe('M4 exit criterion 4: MCP/CLI equivalence', () => {
  it('validate_proposal equals `proposal validate --json` across the domain outcome space', () => {
    const model = baseline();
    const node = targetNode(model);
    const evidence = firstEvidenceOf(node)!;
    const { claim: human } = addHumanClaim();
    const withHuman = baseline();

    const cases: Record<string, Proposal> = {
      positive: proposalFor([{ op: 'add', target: { class: 'claim', node_id: node.id }, value: agentClaim(evidence, 'claim_positive') }], withHuman),
      invalid: { proposal_schema_version: 1, base_commit: withHuman.snapshot.base_commit, model_hash: computeModelHash(withHuman), operations: [{ op: 'add', target: { class: 'claim', node_id: node.id } }] as unknown as Proposal['operations'] },
      forbidden: proposalFor([{ op: 'add', target: { class: 'claim', node_id: node.id }, value: { ...agentClaim(evidence, 'claim_fact'), type: 'fact' } }], withHuman),
      requiresApproval: proposalFor([{ op: 'replace', target: { class: 'claim', node_id: node.id, id: human.id, field: 'status' }, value: 'stale' }], withHuman),
      stale: { ...proposalFor([{ op: 'add', target: { class: 'claim', node_id: node.id }, value: agentClaim(evidence, 'claim_stale') }], withHuman), base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      notFound: proposalFor([{ op: 'add', target: { class: 'claim', node_id: 'no_such_node' }, value: agentClaim(evidence, 'claim_missing') }], withHuman),
    };

    for (const [name, proposal] of Object.entries(cases)) {
      expect(mcpText('validate_proposal', { proposal }), `${name} validate parity`).toBe(cliProposalDomain('validate', proposal));
    }
    // The outcomes are genuinely distinct, not all one verdict.
    const verdicts = Object.values(cases).map((p) => (mcpPayload('validate_proposal', { proposal: p }) as { verdict: string }).verdict);
    expect(new Set(verdicts)).toEqual(new Set(['valid', 'invalid', 'forbidden', 'requires-approval']));
  });

  it('keeps the #15 query tools equal to their CLI command payloads on a dirty tree', () => {
    writeFileSync(join(repo, CHANGED), `${readFileSync(join(repo, CHANGED), 'utf8')}\ndef added() -> int:\n    return 1\n`);
    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout) as { stale_nodes: string[] };
    const workItems = JSON.parse(runWorkItemsCommand(['--json'], ctx()).stdout) as Record<string, unknown>;
    delete workItems.schema_version;
    delete workItems.command;
    expect(mcpText('list_stale_nodes')).toBe(toCanonicalJson({ stale_nodes: status.stale_nodes }));
    expect(mcpText('get_update_work_items')).toBe(toCanonicalJson(workItems));
  });
});

describe('M4 exit regression matrix', () => {
  it('two runs across a deterministic rescan produce byte-identical proposal/verdict/query artifacts', () => {
    const artifacts = (): { proposal: string; verdict: string; stale: string } => {
      const operations: Proposal['operations'] = [
        { op: 'add', target: { class: 'claim', node_id: targetNode().id }, value: agentClaim(firstEvidenceOf(targetNode())!) },
      ];
      const proposal = mcpPayload('propose_update', { operations });
      return {
        proposal: toCanonicalJson(proposal),
        verdict: mcpText('validate_proposal', { proposal }),
        stale: mcpText('list_stale_nodes'),
      };
    };
    const first = artifacts();
    // A repeat scan is a deterministic no-op (PLAN 13.3: zero tracked diff), so the second run
    // over the re-read baseline reproduces every artifact byte for byte.
    const tracked = inventory({ excludeCache: true });
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(inventory({ excludeCache: true })).toEqual(tracked);
    expect(artifacts()).toEqual(first);
  });

  it('normalizes the same operations payload to a byte-identical proposal', () => {
    const operations: Proposal['operations'] = [
      { op: 'add', target: { class: 'claim', node_id: targetNode().id }, value: agentClaim(firstEvidenceOf(targetNode())!) },
    ];
    expect(mcpText('propose_update', { operations })).toBe(mcpText('propose_update', { operations }));
  });

  it('refuses a stale-base proposal through MCP without writing', () => {
    const proposal = { ...proposalFor([{ op: 'add', target: { class: 'claim', node_id: targetNode().id }, value: agentClaim(firstEvidenceOf(targetNode())!) }]), base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    const before = inventory({ excludeCache: true });
    const applied = mcpPayload('apply_proposal', { proposal }) as { verdict: string; errors: Array<{ code: string }> };
    expect(applied.verdict).toBe('invalid');
    expect(applied.errors).toContainEqual(expect.objectContaining({ code: 'stale-base' }));
    expect(inventory({ excludeCache: true })).toEqual(before);
  });

  it('schema-rejects extra or hidden approval-like MCP fields on both write tools', () => {
    const operations: Proposal['operations'] = [
      { op: 'add', target: { class: 'claim', node_id: targetNode().id }, value: agentClaim(firstEvidenceOf(targetNode())!) },
    ];
    const proposal = mcpPayload('propose_update', { operations });
    expect(() => mcp('propose_update', { operations, approvals: [] })).toThrow(ToolInputError);
    expect(() => mcp('apply_proposal', { proposal, approve: 'conflict_x' })).toThrow(ToolInputError);
    expect(() => mcp('apply_proposal', { proposal, extra: true })).toThrow(ToolInputError);
  });

  it('keeps the pre-apply tool sweep read-only and confines a successful apply to node/cache paths', () => {
    writeFileSync(join(repo, CHANGED), `${readFileSync(join(repo, CHANGED), 'utf8')}\ndef added() -> int:\n    return 1\n`);
    const beforeSweep = inventory();
    for (const [tool, args] of [
      ['project_summary', {}],
      ['list_stale_nodes', {}],
      ['get_update_work_items', {}],
      ['context_for_files', { paths: [CHANGED] }],
      ['impact_analysis', { paths: [CHANGED] }],
    ] as Array<[string, Record<string, unknown>]>) {
      mcpPayload(tool, args);
    }
    expect(inventory()).toEqual(beforeSweep);

    const beforeApply = inventory({ excludeCache: true });
    const operations = scriptedConsumerOperations();
    const proposal = mcpPayload('propose_update', { operations });
    expect((mcpPayload('apply_proposal', { proposal }) as { verdict: string }).verdict).toBe('applied');
    const afterApply = inventory({ excludeCache: true });
    const changed = afterApply.filter(([path, bytes]) => {
      const prior = beforeApply.find(([p]) => p === path);
      return !prior || prior[1] !== bytes;
    });
    expect(changed.length).toBeGreaterThan(0);
    for (const [path] of changed) {
      expect(path.startsWith('.archmap/nodes/'), `apply changed a non-node path: ${path}`).toBe(true);
    }
  });

  it('fails a malformed or oversized proposal closed, without server instability', () => {
    const before = inventory({ excludeCache: true });
    // Malformed: not an object / missing everything.
    expect((mcpPayload('validate_proposal', { proposal: {} }) as { verdict: string }).verdict).toBe('invalid');
    expect((mcpPayload('apply_proposal', { proposal: {} }) as { verdict: string }).verdict).toBe('invalid');
    // Oversized: a large operations array is evaluated and refused without a crash.
    const oversized = { proposal_schema_version: 1, base_commit: baseline().snapshot.base_commit, model_hash: computeModelHash(baseline()), operations: Array.from({ length: 200 }, () => ({ op: 'replace', target: { class: 'node', node_id: targetNode().id }, value: { title: 'x' } })) };
    const verdict = (mcpPayload('validate_proposal', { proposal: oversized }) as { verdict: string }).verdict;
    expect(['forbidden', 'invalid']).toContain(verdict);
    expect(inventory({ excludeCache: true })).toEqual(before);
    // The handler is still fully usable afterwards (this repo was never modified, so it is clean).
    expect((mcpPayload('project_summary') as { clean: boolean }).clean).toBe(true);
  });
});
