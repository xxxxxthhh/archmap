import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runSearchCommand } from '../src/cli/search-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { runWorkItemsCommand } from '../src/cli/work-items-command.js';
import type { Claim, Node, Relation } from '../src/model/types.js';
import type { WorkItem } from '../src/query/work-items.js';
import { paths } from '../src/store.js';

let repo: string;
const ctx = () => ({ cwd: repo });

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function write(rel: string, content: string): void {
  const absolute = join(repo, rel);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

type NodeDocument = Node & { schema_version: 1 };

interface WorkItemsPayload {
  snapshot_dirty: boolean;
  items: WorkItem[];
}

function parseWorkItems(stdout: string): WorkItemsPayload {
  return JSON.parse(stdout) as WorkItemsPayload;
}

function nodeDocument(title: string): { path: string; value: NodeDocument } {
  for (const name of readdirSync(paths.nodesDir(repo))) {
    const path = join(paths.nodesDir(repo), name);
    const value = parseYaml(readFileSync(path, 'utf8')) as NodeDocument;
    if (value.title === title) return { path, value };
  }
  throw new Error(`no node titled ${title}`);
}

function archmapBytes(): Array<[string, string]> {
  const root = join(repo, '.archmap');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files
    .sort()
    .map((path) => [relative(root, path), readFileSync(path).toString('base64')]);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-m4-query-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/b.ts', 'export const b = 1;\n');
  write('src/a.ts', "import { b } from './b.js';\nexport const a = b + 1;\n");
  write('docs/readme.md', '# Architecture\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  runInit([], ctx());
  runScanCommand([], ctx());
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('work-items command', () => {
  it('returns an empty byte-identical v1 payload on an unchanged model', () => {
    const first = runWorkItemsCommand(['--json'], ctx());
    const second = runWorkItemsCommand(['--json'], ctx());
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      schema_version: 1,
      command: 'work-items',
      clean: true,
      items: [],
    });
  });

  it('has exact status membership, real evidence, no raw body, and performs no writes', () => {
    const rawBody = 'RAW_SOURCE_BODY_SHOULD_NOT_LEAK_8472';
    write('src/a.ts', `export const value = '${rawBody}';\n`);
    const beforeBytes = archmapBytes();
    const beforeStatus = git('status', '--porcelain');
    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout) as { stale_nodes: string[] };

    const out = runWorkItemsCommand(['--json'], ctx());
    const search = runSearchCommand(['repository', '--json'], ctx());
    const report = parseWorkItems(out.stdout);
    expect(out.exitCode).toBe(0);
    expect(report.items.map((item) => item.node.id)).toEqual(status.stale_nodes);
    expect(report.items.every((item) => item.reasons.length > 0)).toBe(true);
    expect(report.items.every((item) => typeof item.evidence_bundle.omitted_count === 'number')).toBe(true);
    expect(out.stdout).not.toContain(rawBody);
    expect(search.stdout).not.toContain(rawBody);

    for (const item of report.items) {
      for (const target of item.evidence_bundle.evidence_targets) {
        const evidence = runEvidenceCommand([target.target, '--json'], ctx());
        expect(evidence.exitCode).toBe(0);
        expect(JSON.parse(evidence.stdout).found).toBe(true);
      }
    }
    expect(archmapBytes()).toEqual(beforeBytes);
    expect(git('status', '--porcelain')).toBe(beforeStatus);
  });

  it('distinguishes rename and deletion reasons', () => {
    git('mv', 'src/a.ts', 'src/renamed.ts');
    const renamed = parseWorkItems(runWorkItemsCommand(['--json'], ctx()).stdout);
    expect(renamed.items.length).toBeGreaterThan(0);
    expect(renamed.items.every((item) => item.reasons.some((reason) => reason.kind === 'renamed'))).toBe(true);

    git('reset', '--hard', 'HEAD');
    rmSync(join(repo, 'src/a.ts'));
    const deleted = parseWorkItems(runWorkItemsCommand(['--json'], ctx()).stdout);
    expect(deleted.items.length).toBeGreaterThan(0);
    expect(deleted.items.every((item) => item.reasons.some((reason) => reason.kind === 'deleted'))).toBe(true);
  });

  it('attributes a newly added path to the existing containing and repository nodes', () => {
    write('src/new.ts', 'export const added = true;\n');
    const report = parseWorkItems(runWorkItemsCommand(['--json'], ctx()).stdout);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.every((item) => item.reasons.some((reason) => reason.kind === 'added'))).toBe(true);
  });

  it('preserves human/agent enrichment and its real provenance/evidence', () => {
    const source = nodeDocument('src/a.ts');
    const target = nodeDocument('src/b.ts');
    const trackedEvidence = source.value.relations[0]!.evidence![0]!;
    const claim: Claim = {
      id: 'claim_agent_enrichment',
      type: 'inference',
      text: 'Agent-maintained architecture note',
      status: 'active',
      confidence: 0.75,
      provenance: { actor: 'agent', model: 'agent-model', created_at: '2026-07-14T00:00:00Z' },
      evidence: [trackedEvidence],
    };
    const relation: Relation = {
      id: 'rel_human_enrichment',
      type: 'depends-on',
      target: target.value.id,
      certainty: 'partial',
      provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
      evidence: [trackedEvidence],
    };
    source.value.claims.push(claim);
    source.value.relations.push(relation);
    writeFileSync(source.path, stringifyYaml(source.value));
    write('src/a.ts', "import { b } from './b.js';\nexport const a = b + 2;\n");

    const report = parseWorkItems(runWorkItemsCommand(['--json'], ctx()).stdout);
    const item = report.items.find((entry) => entry.node.id === source.value.id)!;
    expect(item.node.claims).toContainEqual(claim);
    expect(item.node.relations).toContainEqual(relation);
  });

  it('keeps a dirty scanned baseline identified as working-tree evidence', () => {
    write('src/a.ts', "import { b } from './b.js';\nexport const a = b + 2;\n");
    runScanCommand([], ctx());
    write('src/a.ts', "import { b } from './b.js';\nexport const a = b + 3;\n");

    const report = parseWorkItems(runWorkItemsCommand(['--json'], ctx()).stdout);
    expect(report.snapshot_dirty).toBe(true);
    const commits = report.items.flatMap((item) =>
      item.node.claims.flatMap((claim) => claim.evidence.map((entry) => entry.commit)).concat(
        item.node.relations.flatMap((relation) => (relation.evidence ?? []).map((entry) => entry.commit)),
      ),
    );
    expect(commits.length).toBeGreaterThan(0);
    expect(new Set(commits)).toEqual(new Set(['working-tree']));
  });

  it('is empty and byte-identical on the unchanged mixed-language fixture', () => {
    rmSync(repo, { recursive: true, force: true });
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-m4-mixed-')));
    const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mixed-repo');
    cpSync(fixture, repo, { recursive: true });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '-m', 'mixed fixture');
    runInit([], ctx());
    runScanCommand([], ctx());

    const first = runWorkItemsCommand(['--json'], ctx());
    const second = runWorkItemsCommand(['--json'], ctx());
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(parseWorkItems(first.stdout).items).toEqual([]);
  });
});

describe('search command and fail-closed command contracts', () => {
  it('has explicit found/not-found exits and byte-stable v1 JSON', () => {
    const found = runSearchCommand(['repository', '--json'], ctx());
    expect(found.exitCode).toBe(0);
    expect(JSON.parse(found.stdout)).toMatchObject({ schema_version: 1, command: 'search', found: true });
    expect(runSearchCommand(['repository', '--json'], ctx()).stdout).toBe(found.stdout);

    const missing = runSearchCommand(['definitely-absent', '--json'], ctx());
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ schema_version: 1, command: 'search', found: false, matches: [] });
  });

  it('rejects unknown flags and empty queries as v1 usage errors', () => {
    for (const out of [
      runWorkItemsCommand(['--jso', '--json'], ctx()),
      runSearchCommand(['repository', '--jso', '--json'], ctx()),
      runSearchCommand(['', '--json'], ctx()),
    ]) {
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe('');
      expect(JSON.parse(out.stderr).schema_version).toBe(1);
    }
  });

  it('fails closed on unscanned and invalid tracked models without partial output', () => {
    rmSync(join(repo, '.archmap', 'snapshot.yaml'));
    rmSync(paths.nodesDir(repo), { recursive: true, force: true });
    for (const out of [runWorkItemsCommand(['--json'], ctx()), runSearchCommand(['repository', '--json'], ctx())]) {
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe('');
      expect(JSON.parse(out.stderr).error).toContain('not scanned yet');
    }

    runScanCommand([], ctx());
    const node = nodeDocument('src/a.ts');
    writeFileSync(node.path, readFileSync(node.path, 'utf8').replace('schema_version: 1', 'schema_version: 2'));
    for (const out of [runWorkItemsCommand(['--json'], ctx()), runSearchCommand(['repository', '--json'], ctx())]) {
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe('');
      expect(JSON.parse(out.stderr).error).toContain('unsupported node document schema_version');
    }
  });
});
