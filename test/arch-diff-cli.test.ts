import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { stringify as stringifyYaml } from 'yaml';

// Drive the published dispatch path end-to-end through the real bin (same approach as
// cli-bin.test.ts): the diff engine reads tracked `.archmap` state at each ref straight from
// the object store, so these probes are the authoritative added/removed/changed evidence.
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', TSX_IMPORT, BIN, ...args], { cwd, encoding: 'utf8' });
}

const PROJECT = {
  schema_version: 1,
  project: { id: 'p', name: 'p' },
  scan: { max_file_bytes: 1000000, exclude_dirs: [], secret_globs: [] },
};

const SNAPSHOT = {
  schema_version: 1,
  base_commit: null,
  dirty: false,
  capabilities: [{ id: 'universal', version: '1', status: 'supported' }],
  files: [],
  excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
};

const evidence = () => ({
  repository: 'repo',
  commit: 'c0',
  path: 'a.ts',
  analyzer: 'universal',
  analyzer_version: '1',
  blob_hash: 'b',
  extract_hash: 'e',
});

type NodeDoc = Record<string, unknown> & { id: string };

let dir: string;

function git(args: string[]) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function writeModel(nodes: NodeDoc[]) {
  const nodesDir = join(dir, '.archmap', 'nodes');
  rmSync(nodesDir, { recursive: true, force: true });
  mkdirSync(nodesDir, { recursive: true });
  for (const n of nodes) {
    writeFileSync(join(nodesDir, `${n.id}.yaml`), stringifyYaml({ schema_version: 1, ...n }));
  }
}

function commit(nodes: NodeDoc[], message: string): string {
  writeModel(nodes);
  git(['add', '-A']);
  git(['commit', '-m', message, '--quiet']);
  return git(['rev-parse', 'HEAD']);
}

// Base and head node sets engineered so every bucket has a distinct, predictable member.
const node = (id: string, over: Partial<NodeDoc> = {}): NodeDoc => ({
  id,
  slug: id.replace(/_/g, '-'),
  kind: 'component',
  title: `Title ${id}`,
  claims: [],
  relations: [],
  ...over,
});

const claim = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'inference',
  text: `text of ${id}`,
  status: 'active',
  confidence: 0.9,
  provenance: { actor: 'human', created_at: '2024-01-01T00:00:00Z' },
  evidence: [evidence()],
  ...over,
});

const relation = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'calls',
  target: 'n_keep',
  certainty: 'partial',
  ...over,
});

const BASE: NodeDoc[] = [
  node('n_keep'),
  node('n_rename', { slug: 'old-name', title: 'Old' }),
  node('n_gone'),
  node('n_svc', {
    relations: [relation('r_calls', { target: 'n_keep' })],
    claims: [claim('c_active', { status: 'active' }), claim('c_edit', { text: 'one' })],
  }),
];

const HEAD: NodeDoc[] = [
  node('n_keep'),
  node('n_rename', { slug: 'new-name', title: 'New' }),
  node('n_new'),
  node('n_svc', {
    relations: [relation('r_calls', { target: 'n_new' }), relation('r_added', { target: 'n_keep' })],
    claims: [
      claim('c_active', { status: 'stale' }),
      claim('c_edit', { text: 'two' }),
      claim('c_added'),
    ],
  }),
];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-diff-')));
  git(['init', '--quiet']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  mkdirSync(join(dir, '.archmap'), { recursive: true });
  writeFileSync(join(dir, '.archmap', 'project.yaml'), stringifyYaml(PROJECT));
  writeFileSync(join(dir, '.archmap', 'snapshot.yaml'), stringifyYaml(SNAPSHOT));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('archmap diff (end-to-end)', () => {
  it('reports exact added/removed/changed/stale sets between two commits', () => {
    const base = commit(BASE, 'base');
    const head = commit(HEAD, 'head');

    const res = run(['diff', base, head, '--json'], dir);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);

    expect(report).toMatchObject({ schema_version: 1, command: 'diff', base, head });
    const ids = (arr: { id: string }[]) => arr.map((e) => e.id);

    expect(ids(report.nodes.added)).toEqual(['n_new']);
    expect(ids(report.nodes.removed)).toEqual(['n_gone']);
    expect(ids(report.nodes.changed.map((c: { after: { id: string } }) => c.after))).toEqual(['n_rename']);

    expect(ids(report.relations.added)).toEqual(['r_added']);
    expect(report.relations.removed).toEqual([]);
    expect(ids(report.relations.changed.map((c: { after: { id: string } }) => c.after))).toEqual(['r_calls']);
    expect(report.relations.changed[0].after).toMatchObject({ id: 'r_calls', node: 'n_svc', target: 'n_new' });

    expect(ids(report.claims.added)).toEqual(['c_added']);
    expect(report.claims.removed).toEqual([]);
    expect(ids(report.claims.changed.map((c: { after: { id: string } }) => c.after))).toEqual(['c_edit']);
    expect(ids(report.claims.stale)).toEqual(['c_active']);
  });

  it('never touches the caller working tree', () => {
    const base = commit(BASE, 'base');
    const head = commit(HEAD, 'head');
    run(['diff', base, head, '--json'], dir);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('defaults head to HEAD when only a base is given', () => {
    const base = commit(BASE, 'base');
    commit(HEAD, 'head');
    const withDefault = run(['diff', base, '--json'], dir);
    const explicit = run(['diff', base, 'HEAD', '--json'], dir);
    expect(withDefault.status).toBe(0);
    expect(withDefault.stdout).toEqual(explicit.stdout);
  });

  it('defines diff X X as an empty result with exit 0', () => {
    const base = commit(BASE, 'base');
    commit(HEAD, 'head');
    const res = run(['diff', base, base, '--json'], dir);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report).toMatchObject({
      base,
      head: base,
      nodes: { added: [], removed: [], changed: [] },
      relations: { added: [], removed: [], changed: [] },
      claims: { added: [], removed: [], changed: [], stale: [] },
    });

    const text = run(['diff', base, base], dir);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('no architecture changes');
  });

  it('fails closed on an unknown ref with a structured exit-2 error', () => {
    commit(BASE, 'base');
    const res = run(['diff', 'no-such-ref', '--json'], dir);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stderr)).toMatchObject({ schema_version: 1 });
    expect(JSON.parse(res.stderr).error).toContain('no-such-ref');
  });

  it('fails closed on an option-shaped ref instead of running it as a git option', () => {
    commit(BASE, 'base');
    const res = run(['diff', '--upload-pack=touch pwned', '--json'], dir);
    expect(res.status).toBe(2);
  });

  it('fails closed on a semantically incompatible historical node model', () => {
    const base = commit(BASE, 'base');
    const invalid = [
      node('n_source', {
        relations: [relation('r_dangling', { certainty: 'known', target: 'n_missing' })],
      }),
    ];
    const head = commit(invalid, 'incompatible head');

    const res = run(['diff', base, head, '--json'], dir);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stderr)).toMatchObject({ schema_version: 1 });
    expect(JSON.parse(res.stderr).error).toContain('relation target "n_missing"');
  });

  it('fails closed when historical nodes exist without their snapshot baseline', () => {
    const base = commit(BASE, 'base');
    rmSync(join(dir, '.archmap', 'snapshot.yaml'));
    git(['add', '-A']);
    git(['commit', '-m', 'missing snapshot', '--quiet']);
    const head = git(['rev-parse', 'HEAD']);

    const res = run(['diff', base, head, '--json'], dir);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stderr).error).toContain('exist without a snapshot');
  });

  it('fails closed on a malformed historical snapshot even without node documents', () => {
    const base = commit(BASE, 'base');
    rmSync(join(dir, '.archmap', 'nodes'), { recursive: true, force: true });
    writeFileSync(join(dir, '.archmap', 'snapshot.yaml'), 'schema_version: 99\n');
    git(['add', '-A']);
    git(['commit', '-m', 'malformed snapshot', '--quiet']);
    const head = git(['rev-parse', 'HEAD']);

    const res = run(['diff', base, head, '--json'], dir);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stderr).error).toContain('unsupported snapshot.yaml schema_version');
  });

  it('renders a deterministic text summary with section counts', () => {
    const base = commit(BASE, 'base');
    const head = commit(HEAD, 'head');
    const res = run(['diff', base, head], dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nodes: 1 added, 1 removed, 1 changed');
    expect(res.stdout).toContain('claims: 1 added, 0 removed, 1 changed, 1 stale');
  });
});
