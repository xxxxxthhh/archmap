import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { runContextCommand } from '../src/cli/context-command.js';
import { runImpactCommand } from '../src/cli/impact-command.js';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { paths, readNodes } from '../src/store.js';
import { discover } from '../src/scan/discover.js';
import { prospectiveModel } from '../src/scan/projection.js';
import { validateManifest } from '../src/validate/validate.js';
import { DEFAULT_EXCLUDE_DIRS, DEFAULT_MAX_FILE_BYTES, DEFAULT_SECRET_GLOBS } from '../src/scan/exclude.js';

let repo: string;
const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const ctx = () => ({ cwd: repo });
function nodeIdByTitle(title: string): string {
  for (const e of readdirSync(paths.nodesDir(repo))) {
    const d = parseYaml(readFileSync(join(paths.nodesDir(repo), e), 'utf8'));
    if (d.title === title) return d.id;
  }
  throw new Error(`no node titled ${title}`);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-m2-')));
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('src/util.ts', 'export const util = 1;\n');
  write('src/a.ts', "import { util } from './util.js';\nexport const a = util + 1;\n");
  write('src/b.ts', "import { a } from './a.js';\nexport const b = a + 1;\n");
  write('src/lonely.ts', 'export const lonely = 0;\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  runInit([], ctx());
  runScanCommand([], ctx());
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('scan with the TypeScript adapter', () => {
  it('is idempotent and status stays clean', () => {
    const before = readNodes(repo);
    runScanCommand([], ctx());
    expect(readNodes(repo)).toEqual(before);
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
    expect(JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout).changed).toBe(false);
  });

  it('stales only the edited module + its parent directory view (not unrelated modules)', () => {
    write('src/util.ts', 'export const util = 999;\n');
    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(status.clean).toBe(false);
    const stale = new Set<string>(status.stale_nodes);
    expect(stale.has(nodeIdByTitle('src/util.ts'))).toBe(true); // the edited module
    expect(stale.has(nodeIdByTitle('src'))).toBe(true); // parent directory view
    expect(stale.has(nodeIdByTitle('src/lonely.ts'))).toBe(false); // unrelated module untouched
  });
});

describe('context command', () => {
  it('selects the target + neighbors within budget, with evidence-backed node payloads', () => {
    const out = runContextCommand(['src/a.ts', '--json'], ctx());
    expect(out.exitCode).toBe(0);
    const report = JSON.parse(out.stdout);
    const reasons = new Map<string, string>(
      report.included.map((s: { node: { title: string }; reason: string }) => [s.node.title, s.reason]),
    );
    expect(reasons.get('src/a.ts')).toContain('target');
    expect(reasons.get('src/util.ts')).toContain('imported by'); // a imports util
    expect(reasons.get('src/b.ts')).toContain('imports the requested file'); // b imports a
    expect(report.used_tokens).toBeLessThanOrEqual(report.budget);
    // the payload is the actual node the agent reads (scope/relations/evidence), not a stub
    const target = report.included.find((s: { node: { title: string } }) => s.node.title === 'src/a.ts');
    expect(target.node.relations[0].evidence[0].path).toBe('src/a.ts');
  });

  it('is a hard budget: a budget too small omits even the target and never exceeds', () => {
    const report = JSON.parse(runContextCommand(['src/a.ts', '--budget', '1', '--json'], ctx()).stdout);
    expect(report.included).toHaveLength(0);
    expect(report.used_tokens).toBe(0);
    expect(report.used_tokens).toBeLessThanOrEqual(1);
    expect(report.omitted.some((o: { title: string }) => o.title === 'src/a.ts')).toBe(true);
  });

  it('rejects a non-positive budget', () => {
    expect(runContextCommand(['src/a.ts', '--budget', '0', '--json'], ctx()).exitCode).toBe(2);
  });
});

describe('impact command', () => {
  it('includes the transitive closure of importers', () => {
    const report = JSON.parse(runImpactCommand(['src/util.ts', '--json'], ctx()).stdout);
    const titles = new Set(report.impacted.map((e: { title: string }) => e.title));
    expect(titles.has('src/util.ts')).toBe(true);
    expect(titles.has('src/a.ts')).toBe(true); // imports util
    expect(titles.has('src/b.ts')).toBe(true); // imports a -> transitively util
    expect(titles.has('src/lonely.ts')).toBe(false);
  });
});

describe('evidence command', () => {
  it('navigates a module node id to its evidence', () => {
    const id = nodeIdByTitle('src/a.ts');
    const report = JSON.parse(runEvidenceCommand([id, '--json'], ctx()).stdout);
    expect(report.found).toBe(true);
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(report.evidence[0].analyzer).toBe('typescript');
  });

  it('exits 1 for an unknown id', () => {
    expect(runEvidenceCommand(['node_missing', '--json'], ctx()).exitCode).toBe(1);
  });
});

describe('read-only trial on a real repository (archmap itself)', () => {
  it('analyzes the archmap source into a contract-valid model without writing', () => {
    const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
    const scan = {
      max_file_bytes: DEFAULT_MAX_FILE_BYTES,
      exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
      secret_globs: [...DEFAULT_SECRET_GLOBS],
    };
    const discovery = discover(root, scan);
    const model = prospectiveModel(discovery, 'archmap', [], scan);
    const result = validateManifest({
      schema_version: 1,
      capabilities: model.snapshot.capabilities,
      nodes: model.nodes,
    });
    expect(result, JSON.stringify(result.errors?.slice(0, 3))).toEqual({ valid: true, errors: [] });

    // The analyzer produced module nodes for real source files, each import navigable.
    const discoverModule = model.nodes.find((n) => n.title === 'src/scan/discover.ts');
    expect(discoverModule?.kind).toBe('module');
    expect((discoverModule?.relations.length ?? 0)).toBeGreaterThan(0);
    for (const rel of discoverModule!.relations) {
      expect(rel.evidence?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

const nodeFilePath = (title: string) => join(paths.nodesDir(repo), `${nodeIdByTitle(title)}.yaml`);

describe('evidence identity under a dirty working tree', () => {
  it('uses working-tree identity (not HEAD) when the scanned tree is dirty', () => {
    write('src/tool.ts', '#!/usr/bin/env node\nexport const v = 1;\n');
    git('add', '-A');
    git('commit', '-m', 'tool');
    runScanCommand([], ctx()); // clean scan: evidence.commit = HEAD
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const cleanEv = parseYaml(readFileSync(nodeFilePath('src/tool.ts'), 'utf8')).claims[0].evidence[0];
    expect(cleanEv.commit).toBe(head);

    write('src/tool.ts', '#!/usr/bin/env node\nexport const v = 2;\n'); // now dirty
    runScanCommand([], ctx());
    const snap = parseYaml(readFileSync(paths.snapshot(repo), 'utf8'));
    expect(snap.dirty).toBe(true);
    expect(snap.base_commit).toBe(head); // snapshot still records the base commit
    const dirtyEv = parseYaml(readFileSync(nodeFilePath('src/tool.ts'), 'utf8')).claims[0].evidence[0];
    expect(dirtyEv.commit).toBe('working-tree'); // evidence identity is the working tree, not HEAD
  });
});

describe('manual relation preservation (analyzer-owned boundary)', () => {
  // A contract-valid manual relation whose id is deliberately shaped like an analyzer id
  // (rel_<16 hex>) and which carries NO provenance (a legacy/manual relation). Ownership is
  // decided by schema-backed provenance, so this must be preserved, not deleted by naming.
  const manualRelation = () => ({
    id: 'rel_0123456789abcdef',
    type: 'depends-on',
    target: nodeIdByTitle('src/util.ts'),
    certainty: 'partial',
    evidence: [
      { repository: 'local', commit: 'working-tree', path: 'src/lonely.ts', analyzer: 'typescript', analyzer_version: '0.1.0', blob_hash: 'sha256:x', extract_hash: 'sha256:y' },
    ],
  });

  it('preserves a manual relation (analyzer-shaped id, no provenance) across an unchanged rescan', () => {
    const f = nodeFilePath('src/lonely.ts');
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.relations = [...(doc.relations ?? []), manualRelation()];
    writeFileSync(f, stringifyYaml(doc));

    expect(runStatusCommand([], ctx()).exitCode).toBe(0); // manual relation is not analyzer drift
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    const after = parseYaml(readFileSync(f, 'utf8'));
    expect(after.relations.some((r: { id: string }) => r.id === 'rel_0123456789abcdef')).toBe(true);
  });

  it('fails closed rather than dropping a manual relation on a vanished node', () => {
    const f = nodeFilePath('src/lonely.ts');
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.relations = [...(doc.relations ?? []), manualRelation()];
    writeFileSync(f, stringifyYaml(doc));
    rmSync(join(repo, 'src/lonely.ts')); // the module (and its node) would vanish

    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('drop human-authored');
  });
});
