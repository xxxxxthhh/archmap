import { spawnSync } from 'node:child_process';
import {
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheckCommand } from '../src/cli/check-command.js';
import { formatCheckMarkdown } from '../src/check/format.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { toCanonicalYaml } from '../src/model/canonical.js';
import type { Node } from '../src/model/types.js';
import { paths, readNodes } from '../src/store.js';
import type { CheckReport } from '../src/check/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

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

function rule(name: string, severity: 'warning' | 'error', from: string): void {
  write(
    `.archmap/rules/${name}.yaml`,
    `schema_version: 1\nid: ${name}\nseverity: ${severity}\nfrom:\n  path: ${from}\ndisallow:\n  edge_type: imports\n  target:\n    path: src/db/**\n`,
  );
}

function bytes(): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(repo);
  return files.sort().map((path) => [relative(repo, path), readFileSync(path).toString('base64')]);
}

function nodeFor(path: string): Node {
  const node = readNodes(repo).find((entry) =>
    entry.scope?.files?.length === 1 && entry.scope.files[0] === path,
  );
  if (!node) throw new Error(`missing node for ${path}`);
  return node;
}

function addPartialRelation(): void {
  const source = nodeFor('src/partial/client.ts');
  const target = nodeFor('src/db/connection.ts');
  const path = join(paths.nodesDir(repo), `${source.id}.yaml`);
  const document = parseYaml(readFileSync(path, 'utf8')) as Node & { schema_version: 1 };
  document.relations.push({
    id: 'rel_human_partial_db',
    type: 'imports',
    target: target.id,
    certainty: 'partial',
    provenance: { actor: 'human', created_at: '2026-07-16T00:00:00Z' },
  });
  writeFileSync(path, toCanonicalYaml(document));
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-check-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/db/connection.ts', 'export const connection = 1;\n');
  write('src/ui/panel.ts', "import { connection } from '../db/connection.js';\nexport const panel = connection;\n");
  write('src/partial/client.ts', 'export const client = true;\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  expect(runInit([], ctx()).exitCode).toBe(0);
  expect(runScanCommand([], ctx()).exitCode).toBe(0);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('archmap check', () => {
  it('returns a byte-stable, read-only pass report when no rules or stale inputs exist', () => {
    const before = bytes();
    const first = runCheckCommand(['--json'], ctx());
    const second = runCheckCommand(['--json'], ctx());
    const markdown = runCheckCommand([], ctx());

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toEqual({
      schema_version: 1,
      command: 'check',
      strict: false,
      status: 'pass',
      summary: { blocking: 0, errors: 0, warnings: 0 },
      violations: [],
    });
    expect(markdown.exitCode).toBe(0);
    expect(markdown.stdout).toContain('# Archmap check');
    expect(markdown.stdout).toContain('Status: **pass**');
    expect(bytes()).toEqual(before);
  });

  it('blocks a known disallowed dependency and reports its rule, ids, and certainty', () => {
    rule('ui-must-not-access-db', 'error', 'src/ui/**');

    const out = runCheckCommand(['--json'], ctx());
    expect(out.exitCode).toBe(1);
    const report = JSON.parse(out.stdout);
    expect(report).toMatchObject({
      status: 'fail',
      summary: { blocking: 1, errors: 1, warnings: 0 },
    });
    const violation = report.violations.find((entry: { kind: string }) => entry.kind === 'rule');
    expect(violation).toMatchObject({
      kind: 'rule',
      rule_id: 'ui-must-not-access-db',
      severity: 'error',
      blocking: true,
      certainty: 'known',
      relation_type: 'imports',
      source_node_id: nodeFor('src/ui/panel.ts').id,
    });
    const target = readNodes(repo).find((entry) => entry.id === violation.target_node_id);
    expect(target?.scope?.files).toContain('src/db/connection.ts');
    expect(runCheckCommand([], ctx()).stdout).toContain(JSON.stringify(violation.relation_id));
  });

  it('keeps warning rules advisory unless --strict is requested', () => {
    rule('ui-should-not-access-db', 'warning', 'src/ui/**');

    const advisory = JSON.parse(runCheckCommand(['--json'], ctx()).stdout);
    const strict = JSON.parse(runCheckCommand(['--strict', '--json'], ctx()).stdout);
    expect(runCheckCommand(['--json'], ctx()).exitCode).toBe(0);
    expect(runCheckCommand(['--strict', '--json'], ctx()).exitCode).toBe(1);
    expect(advisory).toMatchObject({ status: 'warning', summary: { blocking: 0, warnings: 1 } });
    expect(advisory.violations[0]).toMatchObject({ severity: 'warning', blocking: false });
    expect(strict).toMatchObject({ status: 'fail', summary: { blocking: 1, warnings: 1 } });
    expect(strict.violations[0]).toMatchObject({ severity: 'warning', blocking: true });
  });

  it('preserves partial matches as warnings even for an error rule', () => {
    addPartialRelation();
    rule('partial-must-not-access-db', 'error', 'src/partial/**');

    const advisory = runCheckCommand(['--json'], ctx());
    const strict = runCheckCommand(['--strict', '--json'], ctx());
    expect(advisory.exitCode).toBe(0);
    expect(JSON.parse(advisory.stdout)).toMatchObject({
      status: 'warning',
      violations: [expect.objectContaining({ certainty: 'partial', severity: 'warning', blocking: false })],
    });
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(strict.stdout)).toMatchObject({
      status: 'fail',
      violations: [expect.objectContaining({ certainty: 'partial', severity: 'warning', blocking: true })],
    });
  });

  it('blocks a stale tracked model without writing a report or cache', () => {
    write('src/ui/panel.ts', 'export const panel = 2;\n');
    const before = bytes();

    const out = runCheckCommand(['--json'], ctx());
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({
      status: 'fail',
      violations: [expect.objectContaining({ kind: 'stale-model', severity: 'error', blocking: true })],
    });
    expect(bytes()).toEqual(before);
  });

  it('fails closed with no partial report for malformed rule input', () => {
    write('.archmap/rules/broken.yaml', 'schema_version: 1\nid: broken\nseverity: fatal\n');
    const before = bytes();

    const out = runCheckCommand(['--json'], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe('');
    expect(JSON.parse(out.stderr).error).toContain('invalid rule');
    expect(bytes()).toEqual(before);
  });

  it('rejects a symlinked rule directory through the shared store boundary', () => {
    const outside = join(repo, 'outside-rules');
    mkdirSync(outside);
    writeFileSync(join(outside, 'rule.yaml'), 'schema_version: 1\n');
    symlinkSync(outside, join(repo, '.archmap', 'rules'));

    const out = runCheckCommand(['--json'], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe('');
    expect(JSON.parse(out.stderr).error).toContain('refusing to follow symlink');
  });

  it('quotes model-derived Markdown values with a delimiter that keeps embedded backticks inert', () => {
    const report: CheckReport = {
      schema_version: 1,
      command: 'check',
      strict: false,
      status: 'fail',
      summary: { blocking: 1, errors: 1, warnings: 0 },
      violations: [{
        kind: 'rule',
        rule_id: 'ui-must-not-access-db',
        severity: 'error',
        blocking: true,
        source_node_id: 'node_source',
        target_node_id: 'node_target',
        source_path: 'src/ui/`<script>.ts',
        target_path: 'src/db/connection.ts',
        relation_id: 'rel_source_target',
        relation_type: 'imports',
        certainty: 'known',
      }],
    };

    expect(formatCheckMarkdown(report)).toContain('``"src/ui/`<script>.ts"``');
  });

  it('keeps unknown flags and positionals as usage errors', () => {
    for (const out of [
      runCheckCommand(['--jso', '--json'], ctx()),
      runCheckCommand(['unexpected', '--json'], ctx()),
    ]) {
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe('');
      expect(JSON.parse(out.stderr).schema_version).toBe(1);
    }
  });

  it('dispatches the same stable contract through the real CLI binary', () => {
    const out = spawnSync(process.execPath, ['--import', TSX_IMPORT, BIN, 'check', '--json'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ schema_version: 1, command: 'check', status: 'pass' });
  }, 15_000);
});
