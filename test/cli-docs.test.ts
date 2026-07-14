import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runContextCommand } from '../src/cli/context-command.js';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { runImpactCommand } from '../src/cli/impact-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { paths, readNodes } from '../src/store.js';

let repo: string;
const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const ctx = () => ({ cwd: repo });

function write(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
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

function nodeFor(path: string) {
  const node = readNodes(repo).find((candidate) => candidate.kind === 'store' && candidate.scope?.files?.includes(path));
  if (!node) throw new Error(`missing docs node for ${path}`);
  return node;
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-docs-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('README.md', '# Home\n\n[Guide](docs/guide.md)\n');
  write('docs/guide.md', '# Guide\n\n[Home](../README.md)\n');
  write('decisions/ADR-0001.md', '# Decision\n');
  write('ledger/entries.md', '# Entries\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  expect(runInit([], ctx()).exitCode).toBe(0);
  expect(runScanCommand([], ctx()).exitCode).toBe(0);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('Markdown docs-only scan/query vertical slice', () => {
  it('creates meaningful per-file stores and is byte-stable with clean status', () => {
    const docs = readNodes(repo).filter((node) => node.kind === 'store' && node.scope?.files?.[0]?.endsWith('.md'));
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((node) => node.title !== node.scope?.files?.[0])).toBe(true);
    const before = trackedBytes();
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(trackedBytes()).toBe(before);
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
    expect(JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout).changed).toBe(false);
  });

  it('supports docs context reasons/budget, reverse impact, and convention evidence', () => {
    const context = JSON.parse(runContextCommand(['README.md', '--budget', '100000', '--json'], ctx()).stdout);
    expect(context.used_tokens).toBeLessThanOrEqual(context.budget);
    const reasons = new Map(
      context.included.map((entry: { node: { title: string }; reason: string }) => [entry.node.title, entry.reason]),
    );
    expect(reasons.get('Home')).toContain('target');
    expect(reasons.get('Guide')).toContain('referenced by');

    const impact = JSON.parse(runImpactCommand(['docs/guide.md', '--json'], ctx()).stdout);
    expect(impact.impacted.some((entry: { title: string }) => entry.title === 'Home')).toBe(true);

    const decision = nodeFor('decisions/ADR-0001.md');
    const evidence = JSON.parse(runEvidenceCommand([decision.claims[0]!.id, '--json'], ctx()).stdout);
    expect(evidence.found).toBe(true);
    expect(evidence.evidence[0]).toEqual(expect.objectContaining({ path: 'decisions/ADR-0001.md', analyzer: 'markdown' }));
  });

  it('uses working-tree identity for Markdown evidence after a dirty scan', () => {
    write('README.md', '# Changed Home\n\n[Guide](docs/guide.md)\n');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    const relation = nodeFor('README.md').relations[0]!;
    expect(relation.evidence?.[0]?.commit).toBe('working-tree');
  });
});

describe('Markdown enrichment and fail-closed behavior', () => {
  function enrich(path: string): void {
    const node = nodeFor(path);
    const file = join(paths.nodesDir(repo), `${node.id}.yaml`);
    const document = parseYaml(readFileSync(file, 'utf8'));
    document.claims.push({
      id: 'claim_human_docs_note',
      type: 'inference',
      text: 'Human docs note.',
      status: 'active',
      confidence: 1,
      provenance: { actor: 'human', created_at: '2026-01-01T00:00:00.000Z' },
      evidence: [document.relations[0].evidence[0]],
    });
    writeFileSync(file, stringifyYaml(document));
  }

  it('preserves human enrichment on a Markdown node across rescan', () => {
    enrich('README.md');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(nodeFor('README.md').claims.some((claim) => claim.id === 'claim_human_docs_note')).toBe(true);
  });

  it.each(['delete', 'rename'] as const)('fails closed without partial writes on enriched Markdown %s', (operation) => {
    enrich('README.md');
    const before = trackedBytes();
    if (operation === 'delete') rmSync(join(repo, 'README.md'));
    else renameSync(join(repo, 'README.md'), join(repo, 'RENAMED.md'));

    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('drop human-authored');
    expect(trackedBytes()).toBe(before);
  });
});
