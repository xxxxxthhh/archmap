import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/init-command.js';
import { runProposalCommand } from '../src/cli/proposal-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { toCanonicalYaml } from '../src/model/canonical.js';
import type { Claim, Evidence, Node } from '../src/model/types.js';
import { computeModelHash, type Proposal } from '../src/proposal/index.js';
import { readTrackedBaseline } from '../src/scan/baseline.js';
import { paths } from '../src/store.js';

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

function baseline() {
  const model = readTrackedBaseline(repo);
  if (!model) throw new Error('expected scanned baseline');
  return model;
}

function firstEvidence(): Evidence {
  for (const node of baseline().nodes) {
    for (const claim of node.claims) {
      if (claim.evidence[0]) return claim.evidence[0];
    }
    for (const relation of node.relations) {
      if (relation.evidence?.[0]) return relation.evidence[0];
    }
  }
  throw new Error('expected fixture evidence');
}

function sourceNode(): Node {
  const found = baseline().nodes.find((node) => node.scope?.files?.includes('src/a.ts'));
  if (!found) throw new Error('expected source node');
  return found;
}

function validProposal(): Proposal {
  const model = baseline();
  const node = sourceNode();
  const claim: Claim = {
    id: 'claim_proposed',
    type: 'inference',
    text: 'Evidence-backed proposal',
    status: 'active',
    confidence: 0.7,
    provenance: { actor: 'agent', model: 'test-model', created_at: '2026-07-14T00:00:00Z' },
    evidence: [firstEvidence()],
  };
  return {
    proposal_schema_version: 1,
    base_commit: model.snapshot.base_commit,
    model_hash: computeModelHash(model),
    operations: [{ op: 'add', target: { class: 'claim', node_id: node.id }, value: claim }],
  };
}

function writeProposal(value: unknown, rel = 'proposal.yaml'): string {
  return write(rel, toCanonicalYaml(value));
}

function repositoryBytes(): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  walk(repo);
  return files.sort().map((path) => {
    const value = lstatSync(path).isSymbolicLink() ? `link:${realpathSync(path)}` : readFileSync(path).toString('base64');
    return [relative(repo, path), value];
  });
}

function addHumanClaim(): Claim {
  const model = baseline();
  const node = sourceNode();
  const claim: Claim = {
    id: 'claim_human_decision',
    type: 'inference',
    text: 'Human decision',
    status: 'active',
    confidence: 1,
    provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
    evidence: [firstEvidence()],
  };
  const path = join(paths.nodesDir(repo), `${node.id}.yaml`);
  const document = parseYaml(readFileSync(path, 'utf8')) as Node & { schema_version: 1 };
  document.claims.push(claim);
  writeFileSync(path, toCanonicalYaml(document));
  expect(readTrackedBaseline(repo)).not.toBeNull();
  expect(model.nodes.find((entry) => entry.id === node.id)?.claims).not.toContainEqual(claim);
  return claim;
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-proposal-')));
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

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('proposal validate/preview CLI', () => {
  it('returns byte-identical valid validation and canonical preview without writes', () => {
    writeProposal(validProposal());
    const before = repositoryBytes();
    const validate = runProposalCommand('validate', ['proposal.yaml', '--json'], ctx());
    const repeated = runProposalCommand('validate', ['proposal.yaml', '--json'], ctx());
    const preview = runProposalCommand('preview', ['proposal.yaml', '--json'], ctx());

    expect(validate.exitCode).toBe(0);
    expect(repeated.stdout).toBe(validate.stdout);
    expect(JSON.parse(validate.stdout)).toMatchObject({
      schema_version: 1,
      command: 'proposal validate',
      verdict: 'valid',
    });
    const previewPayload = JSON.parse(preview.stdout);
    expect(previewPayload).toMatchObject({
      schema_version: 1,
      command: 'proposal preview',
      verdict: 'valid',
    });
    expect(previewPayload.diff).toHaveLength(1);
    expect(repositoryBytes()).toEqual(before);
  });

  it('reads only the tracked validated baseline even when source and other files are dirty', () => {
    writeProposal(validProposal());
    write('src/a.ts', 'export const dirty = true;\n');
    write('untracked.txt', 'dirty\n');
    const before = repositoryBytes();
    const result = runProposalCommand('preview', ['proposal.yaml', '--json'], ctx());
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe('valid');
    expect(repositoryBytes()).toEqual(before);
  });

  it('is byte-read-only for invalid, forbidden, requires-approval, and stale verdicts', () => {
    const human = addHumanClaim();
    const model = baseline();
    const node = sourceNode();
    const common = {
      proposal_schema_version: 1 as const,
      base_commit: model.snapshot.base_commit,
      model_hash: computeModelHash(model),
    };
    const cases: Array<[string, unknown, string]> = [
      ['invalid.yaml', { ...common, operations: [] }, 'invalid'],
      [
        'forbidden.yaml',
        { ...common, operations: [{ op: 'replace', target: { class: 'node', node_id: node.id }, value: {} }] },
        'forbidden',
      ],
      [
        'approval.yaml',
        {
          ...common,
          operations: [
            {
              op: 'replace',
              target: { class: 'claim', node_id: node.id, id: human.id, field: 'status' },
              value: 'stale',
            },
          ],
        },
        'requires-approval',
      ],
      [
        'stale.yaml',
        { ...validProposal(), model_hash: 'sha256:' + '0'.repeat(64) },
        'invalid',
      ],
    ];

    for (const [path, input] of cases) writeProposal(input, path);
    const before = repositoryBytes();
    for (const [path, , verdict] of cases) {
      const result = runProposalCommand('preview', [path, '--json'], ctx());
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload.verdict).toBe(verdict);
      expect(payload).not.toHaveProperty('diff');
    }
    expect(repositoryBytes()).toEqual(before);
  });

  it('turns parser, path-boundary, and symlink failures into structured invalid verdicts', () => {
    write('malformed.yaml', 'proposal_schema_version: [oops\n');
    writeProposal(validProposal(), '.archmap/external-looking.yaml');
    const outside = writeProposal(validProposal(), 'outside.yaml');
    symlinkSync(outside, join(repo, 'linked.yaml'));

    for (const path of ['malformed.yaml', '.archmap/external-looking.yaml', 'linked.yaml']) {
      const first = runProposalCommand('validate', [path, '--json'], ctx());
      const second = runProposalCommand('validate', [path, '--json'], ctx());
      expect(first.exitCode).toBe(1);
      expect(second.stdout).toBe(first.stdout);
      expect(JSON.parse(first.stdout)).toMatchObject({ verdict: 'invalid' });
    }
  });

  it('rejects unknown flags and wrong arity as usage errors', () => {
    for (const result of [
      runProposalCommand('validate', ['proposal.yaml', '--jso', '--json'], ctx()),
      runProposalCommand('preview', ['--json'], ctx()),
    ]) {
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).schema_version).toBe(1);
    }
  });
});
