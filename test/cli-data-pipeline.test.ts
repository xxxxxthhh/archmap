import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runContextCommand } from '../src/cli/context-command.js';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { runImpactCommand } from '../src/cli/impact-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { paths, readNodes, readSnapshot } from '../src/store.js';
import { validateManifest } from '../src/validate/validate.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data-repo');
let repo: string;
const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const ctx = () => ({ cwd: repo });

function copyFixture(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'golden.nodes.json') continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyFixture(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}

function trackedBytes(): string {
  return [
    readFileSync(paths.snapshot(repo), 'utf8'),
    ...readdirSync(paths.nodesDir(repo))
      .filter((name) => name.endsWith('.yaml'))
      .sort()
      .map((name) => `${name}\n${readFileSync(join(paths.nodesDir(repo), name), 'utf8')}`),
  ].join('\n---\n');
}

function nodeForPath(path: string) {
  const node = readNodes(repo).find(
    (candidate) => candidate.scope?.files?.length === 1 && candidate.scope.files[0] === path &&
      (candidate.title === path || candidate.kind === 'store'),
  );
  if (!node) throw new Error(`missing per-file node for ${path}`);
  return node;
}

function enrichDataNode(path: string): void {
  const node = nodeForPath(path);
  const file = join(paths.nodesDir(repo), `${node.id}.yaml`);
  const document = parseYaml(readFileSync(file, 'utf8'));
  document.claims.push({
    id: `claim_human_${path.replace(/\W/g, '_')}`,
    type: 'inference',
    text: 'Human data note.',
    status: 'active',
    confidence: 1,
    provenance: { actor: 'human', created_at: '2026-01-01T00:00:00.000Z' },
    evidence: [document.claims[0].evidence[0]],
  });
  writeFileSync(file, stringifyYaml(document));
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-data-')));
  copyFixture(fixtureRoot, repo);
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  expect(runInit([], ctx()).exitCode).toBe(0);
  expect(runScanCommand([], ctx()).exitCode).toBe(0);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('YAML/JSON Python/data/docs CLI pipeline', () => {
  it('persists the exact target-complete edge matrix without leaking values', () => {
    const nodes = readNodes(repo);
    const snapshot = readSnapshot(repo)!;
    expect(validateManifest({ schema_version: 1, capabilities: snapshot.capabilities, nodes })).toEqual({
      valid: true,
      errors: [],
    });

    const dataById = new Map(
      nodes
        .filter((node) => node.kind === 'store' && node.title.match(/\.(?:ya?ml|json)$/))
        .map((node) => [node.id, node.title]),
    );
    expect([...dataById.values()].sort()).toEqual([
      'config/settings.json',
      'data/input.yaml',
      'data/invalid.yaml',
      'data/output.json',
    ]);
    expect(nodes.some((node) => node.title === 'package.json' && node.kind === 'store')).toBe(false);

    const transform = nodeForPath('transform.py');
    const codeEdges = transform.relations
      .filter((relation) => ['reads', 'writes', 'depends-on'].includes(relation.type))
      .map((relation) => `${relation.type}/${relation.certainty}/${dataById.get(relation.target)}`)
      .sort();
    expect(codeEdges).toEqual([
      'depends-on/partial/config/settings.json',
      'reads/partial/data/input.yaml',
      'writes/partial/data/output.json',
    ]);

    const report = nodeForPath('report.md');
    expect(report.relations.map((relation) =>
      `${relation.type}/${relation.certainty}/${dataById.get(relation.target)}`).sort()).toEqual([
      'depends-on/known/data/input.yaml',
      'depends-on/known/data/output.json',
    ]);

    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      for (const claim of node.claims) expect(claim.evidence.length).toBeGreaterThan(0);
      for (const relation of node.relations) {
        expect(ids.has(relation.target), `${node.title} -> ${relation.target}`).toBe(true);
        expect(relation.evidence?.length ?? 0).toBeGreaterThan(0);
      }
    }
    const stored = trackedBytes();
    for (const value of [
      'INPUT_VALUE_CANARY',
      'CONFIG_VALUE_CANARY',
      'OUTPUT_VALUE_CANARY',
      'INVALID_VALUE_CANARY',
      'MANIFEST_VALUE_CANARY',
      'SECRET_PATH_VALUE_CANARY',
    ]) {
      expect(stored).not.toContain(value);
    }
  });

  it('proves context, impact, and relation evidence through the CLI seams', () => {
    const context = JSON.parse(runContextCommand(['transform.py', '--budget', '100000', '--json'], ctx()).stdout);
    expect(context.used_tokens).toBeLessThanOrEqual(context.budget);
    const included = new Set(context.included.map((entry: { node: { title: string } }) => entry.node.title));
    const reasons = new Map(
      context.included.map((entry: { node: { title: string }; reason: string }) => [entry.node.title, entry.reason]),
    );
    expect(included.has('config/settings.json')).toBe(true);
    expect(included.has('data/input.yaml')).toBe(true);
    expect(included.has('data/output.json')).toBe(true);
    expect(reasons.get('config/settings.json')).toContain('referenced by');
    expect(reasons.get('data/input.yaml')).toContain('read by');
    expect(reasons.get('data/output.json')).toContain('written by');

    const inputImpact = JSON.parse(runImpactCommand(['data/input.yaml', '--json'], ctx()).stdout);
    expect(inputImpact.impacted.some((entry: { title: string }) => entry.title === 'transform.py')).toBe(true);
    const outputImpact = JSON.parse(runImpactCommand(['data/output.json', '--json'], ctx()).stdout);
    const outputTitles = new Set(outputImpact.impacted.map((entry: { title: string }) => entry.title));
    expect(outputTitles.has('transform.py')).toBe(true);
    expect(outputTitles.has('Pipeline report')).toBe(true);

    const writeEdge = nodeForPath('transform.py').relations.find((relation) => relation.type === 'writes')!;
    const evidence = JSON.parse(runEvidenceCommand([writeEdge.id, '--json'], ctx()).stdout);
    expect(evidence).toEqual(expect.objectContaining({ found: true, matched: 'relation' }));
    expect(evidence.evidence[0]).toEqual(expect.objectContaining({
      path: 'transform.py',
      analyzer: 'python',
      blob_hash: expect.stringMatching(/^sha256:/),
      extract_hash: expect.stringMatching(/^sha256:/),
    }));
  });

  it('is byte-stable on zero-diff rescan and uses dirty working-tree identity', () => {
    const before = trackedBytes();
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(trackedBytes()).toBe(before);
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
    expect(JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout).changed).toBe(false);

    appendFileSync(join(repo, 'transform.py'), '\n# dirty\n');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    const relations = nodeForPath('transform.py').relations.filter((relation) =>
      ['reads', 'writes', 'depends-on'].includes(relation.type));
    expect(relations.every((relation) => relation.evidence?.[0]?.commit === 'working-tree')).toBe(true);
  });

  it('preserves data-node enrichment and fails closed on enriched deletion', () => {
    enrichDataNode('data/output.json');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(nodeForPath('data/output.json').claims.some((claim) => claim.id === 'claim_human_data_output_json')).toBe(true);

    enrichDataNode('data/input.yaml');
    const before = trackedBytes();
    rmSync(join(repo, 'data/input.yaml'));
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('drop human-authored');
    expect(trackedBytes()).toBe(before);
  });

  it('fails closed on malformed Python parser output without partial writes', () => {
    const worker = join(repo, 'malformed-worker.py');
    writeFileSync(worker, [
      'import json, sys',
      'if sys.argv[1:] == ["--probe"]:',
      '    print(json.dumps({"protocol_version": 1, "status": "ok", "python_version": [3, 12, 0], "stdlib": []}))',
      'elif sys.argv[1:] == ["--dependencies"]:',
      '    print(json.dumps({"protocol_version": 1, "status": "ok", "dependencies": []}))',
      'else:',
      '    print("not-json")',
      '',
    ].join('\n'));
    const before = trackedBytes();
    const previous = process.env.ARCHMAP_PYTHON_WORKER;
    process.env.ARCHMAP_PYTHON_WORKER = worker;
    try {
      const out = runScanCommand([], ctx());
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('malformed');
      expect(trackedBytes()).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.ARCHMAP_PYTHON_WORKER;
      else process.env.ARCHMAP_PYTHON_WORKER = previous;
    }
  });
});
