import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { paths, readNodes } from '../src/store.js';

let repo: string;
let external: string;

function git(...args: string[]): void {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}
function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const ctx = () => ({ cwd: repo });

function nodeFileFor(sub: string): string {
  const dir = paths.nodesDir(repo);
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (readFileSync(p, 'utf8').includes(sub)) return p;
  }
  throw new Error(`no node file scopes ${sub}`);
}

/** The structural (directory) node file with the given title — the node that owns forward
 * coverage for files directly in that directory (module nodes also scope TS/JS files). */
function dirNodeFile(title: string): string {
  const dir = paths.nodesDir(repo);
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (parseYaml(readFileSync(p, 'utf8')).title === title) return p;
  }
  throw new Error(`no node with title ${title}`);
}

function humanClaim(path: string) {
  return {
    id: 'claim_human',
    type: 'inference',
    text: 'human interpretation',
    status: 'active',
    confidence: 0.9,
    provenance: { actor: 'human', created_at: '2026-07-13T00:00:00Z' },
    evidence: [
      { repository: 'local', commit: 'a', path, analyzer: 'universal', analyzer_version: '0.1.0', blob_hash: 'sha256:x', extract_hash: 'sha256:y' },
    ],
  };
}

/** A hash of the whole tracked + cached store state, to assert a failed scan changed nothing. */
function trackedStateHash(): string {
  const parts: string[] = [readFileSync(paths.snapshot(repo), 'utf8')];
  const nd = paths.nodesDir(repo);
  for (const e of readdirSync(nd).sort()) parts.push(`${e}:${readFileSync(join(nd, e), 'utf8')}`);
  parts.push(existsSync(paths.index(repo)) ? readFileSync(paths.index(repo), 'utf8') : '');
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-safety-')));
  external = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-external-')));
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('src/a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  runInit([], ctx());
  runScanCommand([], ctx());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

describe('store symlink safety', () => {
  it('refuses a snapshot.yaml symlinked outside the repo and leaves the target untouched', () => {
    const sentinel = join(external, 'sentinel');
    writeFileSync(sentinel, 'ORIGINAL\n');
    rmSync(paths.snapshot(repo));
    symlinkSync(sentinel, paths.snapshot(repo));

    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('symlink');
    expect(readFileSync(sentinel, 'utf8')).toBe('ORIGINAL\n');
  });

  it('refuses a nodes/ dir symlinked outside the repo and deletes/writes nothing there', () => {
    const victim = join(external, 'victim.yaml');
    writeFileSync(victim, 'VICTIM\n');
    rmSync(paths.nodesDir(repo), { recursive: true });
    symlinkSync(external, paths.nodesDir(repo));

    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(existsSync(victim)).toBe(true);
    expect(readdirSync(external).filter((e) => e.startsWith('node_'))).toEqual([]);
  });

  it('refuses a cache/ dir symlinked outside the repo', () => {
    rmSync(paths.cacheDir(repo), { recursive: true, force: true });
    symlinkSync(external, paths.cacheDir(repo));
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
  });

  it('refuses to read a node file that is a symlink to an outside file', () => {
    const secret = join(external, 'secret.yaml');
    writeFileSync(secret, 'schema_version: 1\n');
    const nodeFile = readdirSync(paths.nodesDir(repo)).find((e) => e.endsWith('.yaml'))!;
    rmSync(join(paths.nodesDir(repo), nodeFile));
    symlinkSync(secret, join(paths.nodesDir(repo), nodeFile));

    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('symlink');
  });
});

describe('node document validation', () => {
  function firstNodePath(): string {
    const name = readdirSync(paths.nodesDir(repo)).find((e) => e.endsWith('.yaml'))!;
    return join(paths.nodesDir(repo), name);
  }

  it('rejects an unsupported node schema_version', () => {
    const p = firstNodePath();
    writeFileSync(p, readFileSync(p, 'utf8').replace('schema_version: 1', 'schema_version: 2'));
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unsupported node document schema_version 2');
  });

  it('rejects malformed node YAML with a stable error, not an uncaught throw', () => {
    writeFileSync(firstNodePath(), 'schema_version: 1\nkind: [oops\n');
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
  });

  it('rejects a semantically invalid node (bad kind)', () => {
    const p = firstNodePath();
    writeFileSync(p, readFileSync(p, 'utf8').replace(/kind: \w+/, 'kind: bogus'));
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
  });

  it('writes node files as versioned documents', () => {
    const p = firstNodePath();
    expect(readFileSync(p, 'utf8')).toContain('schema_version: 1');
    // readNodes strips the version tag and returns a plain Node.
    expect(readNodes(repo)[0]).not.toHaveProperty('schema_version');
  });
});

describe('node semantic contract (full M0 validation on read)', () => {
  function overwriteFirstNode(body: string): void {
    const name = readdirSync(paths.nodesDir(repo)).find((e) => e.endsWith('.yaml'))!;
    writeFileSync(join(paths.nodesDir(repo), name), body);
  }

  it('rejects an agent-authored fact (Facts/Interpretations boundary)', () => {
    overwriteFirstNode(
      [
        'schema_version: 1',
        'id: node_agentfact',
        'slug: agentfact',
        'kind: component',
        'title: Agent Fact',
        'claims:',
        '  - id: claim_x',
        '    type: fact',
        '    text: AI fact pretending to be deterministic',
        '    status: active',
        '    confidence: 1',
        '    provenance:',
        '      actor: agent',
        '      model: m',
        '      created_at: 2026-07-13T00:00:00Z',
        '    evidence:',
        '      - repository: local',
        '        commit: abc',
        '        path: a.ts',
        '        analyzer: universal',
        '        analyzer_version: 0.1.0',
        '        blob_hash: sha256:x',
        '        extract_hash: sha256:y',
        'relations: []',
        '',
      ].join('\n'),
    );
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('fact claims must be produced by an analyzer');
  });

  it('rejects a dangling relation target', () => {
    overwriteFirstNode(
      [
        'schema_version: 1',
        'id: node_dangler',
        'slug: dangler',
        'kind: component',
        'title: Dangler',
        'claims: []',
        'relations:',
        '  - id: rel_x',
        '    type: calls',
        '    target: node_ghost',
        '    certainty: partial',
        '',
      ].join('\n'),
    );
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('does not reference a known node');
  });

  it('rejects a known relation with no evidence', () => {
    overwriteFirstNode(
      [
        'schema_version: 1',
        'id: node_selfref',
        'slug: selfref',
        'kind: component',
        'title: Self',
        'claims: []',
        'relations:',
        '  - id: rel_x',
        '    type: calls',
        '    target: node_selfref',
        '    certainty: known',
        '',
      ].join('\n'),
    );
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('requires at least one evidence entry');
  });

  it('rejects duplicate node ids across files', () => {
    for (const name of readdirSync(paths.nodesDir(repo)).filter((e) => e.endsWith('.yaml'))) {
      writeFileSync(
        join(paths.nodesDir(repo), name),
        ['schema_version: 1', 'id: node_dup', 'slug: dup', 'kind: component', 'title: Dup', 'claims: []', 'relations: []', ''].join('\n'),
      );
    }
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('duplicate id');
  });
});

describe('store path type validation', () => {
  it('rejects init when .archmap is a regular file', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-type-')));
    try {
      spawnSync('git', ['init'], { cwd: fresh });
      writeFileSync(join(fresh, '.archmap'), 'not a dir\n');
      const out = runInit([], { cwd: fresh });
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('archmap store'); // structured StorePathError, not EEXIST stack
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('rejects scan when nodes/ is a regular file', () => {
    rmSync(paths.nodesDir(repo), { recursive: true });
    writeFileSync(paths.nodesDir(repo), 'file\n');
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('expected a directory');
  });

  it('rejects status when snapshot.yaml is a directory', () => {
    rmSync(paths.snapshot(repo));
    mkdirSync(paths.snapshot(repo));
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('expected a regular file');
  });

  it('rejects scan when cache/ is a regular file', () => {
    rmSync(paths.cacheDir(repo), { recursive: true, force: true });
    writeFileSync(paths.cacheDir(repo), 'file\n');
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('expected a directory');
  });

  it('does not treat a symlinked project.yaml as an initialized project', () => {
    const sentinel = join(external, 'proj.yaml');
    writeFileSync(sentinel, 'schema_version: 1\n');
    rmSync(paths.project(repo));
    symlinkSync(sentinel, paths.project(repo));
    // resolveProjectRoot requires a real regular file, so this is treated as not-a-project.
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
  });
});

describe('M1 tracked-model consistency', () => {
  function nodeFileContaining(sub: string): string {
    const dir = paths.nodesDir(repo);
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (readFileSync(p, 'utf8').includes(sub)) return p;
    }
    throw new Error(`no node file contains ${sub}`);
  }

  it('rejects a node whose scope no longer covers a snapshot file', () => {
    const f = dirNodeFile('src'); // the structural node responsible for forward coverage
    const doc = parseYaml(readFileSync(f, 'utf8'));
    delete doc.scope;
    writeFileSync(f, stringifyYaml(doc));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n'); // modify the now-uncovered file

    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('not covered');
  });

  it('rejects a deleted node set (missing repository root)', () => {
    for (const e of readdirSync(paths.nodesDir(repo))) rmSync(join(paths.nodesDir(repo), e));
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('repository root node');
  });

  it('rejects a node scope that references a path outside the snapshot', () => {
    const f = nodeFileContaining('src/a.ts');
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.scope = { files: ['src/a.ts', 'ghost.ts'] };
    writeFileSync(f, stringifyYaml(doc));

    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('absent from the snapshot');
  });
});

const skipPerm =
  process.platform === 'win32' ||
  (typeof process.getuid === 'function' && process.getuid() === 0);

describe.skipIf(skipPerm)('store I/O error wrapping', () => {
  it('maps a read-side EACCES to a structured error, not a stack trace', () => {
    chmodSync(paths.nodesDir(repo), 0o000);
    try {
      const out = runStatusCommand([], ctx());
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('cannot list');
    } finally {
      chmodSync(paths.nodesDir(repo), 0o755);
    }
  });

  it('maps a write-side EACCES to a structured error', () => {
    // Read-only (not 000): the baseline read succeeds, so the failure is on the write path.
    chmodSync(paths.snapshot(repo), 0o444);
    try {
      const out = runScanCommand([], ctx());
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('cannot write');
    } finally {
      chmodSync(paths.snapshot(repo), 0o644);
    }
  });
});

describe('enrichment preservation (scanner never deletes human interpretations)', () => {
  function moduleNodeFile(): string {
    const dir = paths.nodesDir(repo);
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (readFileSync(p, 'utf8').includes('src/a.ts')) return p;
    }
    throw new Error('no node file scopes src/a.ts');
  }

  function addHumanClaim(): string {
    const f = moduleNodeFile();
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.claims = [
      {
        id: 'claim_human',
        type: 'inference',
        text: 'human interpretation',
        status: 'active',
        confidence: 0.9,
        provenance: { actor: 'human', created_at: '2026-07-13T00:00:00Z' },
        evidence: [
          {
            repository: 'local',
            commit: 'abc',
            path: 'src/a.ts',
            analyzer: 'universal',
            analyzer_version: '0.1.0',
            blob_hash: 'sha256:x',
            extract_hash: 'sha256:y',
          },
        ],
      },
    ];
    writeFileSync(f, stringifyYaml(doc));
    return f;
  }

  it('keeps a valid human claim: status clean, scan --changed no-op, both agree', () => {
    addHumanClaim();

    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout); // read-only first
    expect(status.clean).toBe(true);
    expect(status.drift).toEqual([]);

    const changed = JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout);
    expect(changed.changed).toBe(false);
    expect(status.clean).toBe(!changed.changed); // no contradiction
  });

  it('does not remove the human claim on a full scan', () => {
    const f = addHumanClaim();
    runScanCommand([], ctx());
    const after = parseYaml(readFileSync(f, 'utf8'));
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0].id).toBe('claim_human');
  });
});

describe('scan fails closed on unsafe or invalid tracked model', () => {
  function enrichDocsNodeThen(mutateTree: () => void): string {
    write('docs/b.md', '# b\n');
    git('add', '-A');
    git('commit', '-m', 'add docs');
    runScanCommand([], ctx());
    const df = nodeFileFor('docs/b.md');
    const doc = parseYaml(readFileSync(df, 'utf8'));
    doc.claims = [humanClaim('docs/b.md')];
    writeFileSync(df, stringifyYaml(doc));
    mutateTree();
    return df;
  }

  it('refuses (and preserves the claim) when the enriched node structure is deleted', () => {
    const df = enrichDocsNodeThen(() => rmSync(join(repo, 'docs/b.md')));
    const before = trackedStateHash();

    expect(runStatusCommand([], ctx()).exitCode).toBe(1); // dirty
    const full = runScanCommand([], ctx());
    expect(full.exitCode).toBe(2);
    expect(full.stderr).toContain('drop human-authored');
    expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);

    expect(trackedStateHash()).toBe(before); // nothing written
    expect(parseYaml(readFileSync(df, 'utf8')).claims).toHaveLength(1);
  });

  it('refuses when the enriched node structure is renamed away', () => {
    enrichDocsNodeThen(() => git('mv', 'docs', 'guide'));
    const before = trackedStateHash();
    expect(runScanCommand([], ctx()).exitCode).toBe(2);
    expect(trackedStateHash()).toBe(before);
  });

  const invalidBaselines: Array<{ name: string; corrupt: () => void }> = [
    {
      name: 'duplicate node ids',
      corrupt: () => {
        for (const e of readdirSync(paths.nodesDir(repo))) {
          writeFileSync(
            join(paths.nodesDir(repo), e),
            'schema_version: 1\nid: node_dup\nslug: dup\nkind: component\ntitle: Dup\nclaims: []\nrelations: []\n',
          );
        }
      },
    },
    {
      name: 'dangling relation target',
      corrupt: () => {
        const f = nodeFileFor('src/a.ts');
        const doc = parseYaml(readFileSync(f, 'utf8'));
        doc.relations = [{ id: 'rel_x', type: 'calls', target: 'node_ghost', certainty: 'partial' }];
        writeFileSync(f, stringifyYaml(doc));
      },
    },
    {
      name: 'agent-authored fact',
      corrupt: () => {
        const f = nodeFileFor('src/a.ts');
        const doc = parseYaml(readFileSync(f, 'utf8'));
        doc.claims = [{ ...humanClaim('src/a.ts'), type: 'fact', provenance: { actor: 'agent', model: 'm', created_at: '2026-07-13T00:00:00Z' } }];
        writeFileSync(f, stringifyYaml(doc));
      },
    },
    {
      name: 'scope inconsistency',
      corrupt: () => {
        const f = dirNodeFile('src');
        const doc = parseYaml(readFileSync(f, 'utf8'));
        delete doc.scope;
        writeFileSync(f, stringifyYaml(doc));
      },
    },
  ];

  for (const { name, corrupt } of invalidBaselines) {
    it(`refuses full scan and --changed on an invalid baseline: ${name}`, () => {
      corrupt();
      const before = trackedStateHash();
      expect(runScanCommand([], ctx()).exitCode).toBe(2);
      expect(trackedStateHash()).toBe(before);
      expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);
      expect(trackedStateHash()).toBe(before);
    });
  }
});

describe('snapshot + nodes are one baseline unit', () => {
  it('fails closed when snapshot.yaml is missing but nodes exist, preserving enrichment', () => {
    const f = nodeFileFor('src/a.ts');
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.claims = [humanClaim('src/a.ts')];
    writeFileSync(f, stringifyYaml(doc));
    const nodeBytes = readFileSync(f, 'utf8');
    const cacheBytes = readFileSync(paths.index(repo), 'utf8');
    rmSync(paths.snapshot(repo));

    expect(runStatusCommand([], ctx()).exitCode).toBe(2);
    const full = runScanCommand([], ctx());
    expect(full.exitCode).toBe(2);
    expect(full.stderr).toContain('without a snapshot');
    expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);

    expect(readFileSync(f, 'utf8')).toBe(nodeBytes); // enrichment untouched
    expect(readFileSync(paths.index(repo), 'utf8')).toBe(cacheBytes);
  });

  it('treats a fresh init with no nodes as legally unscanned, then scans', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-fresh2-')));
    try {
      spawnSync('git', ['init'], { cwd: fresh });
      spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: fresh });
      spawnSync('git', ['config', 'user.name', 'T'], { cwd: fresh });
      writeFileSync(join(fresh, 'a.py'), 'x\n');
      spawnSync('git', ['add', '-A'], { cwd: fresh });
      spawnSync('git', ['commit', '-m', 'i'], { cwd: fresh });

      runInit([], { cwd: fresh });
      expect(runStatusCommand(['--json'], { cwd: fresh }).exitCode).toBe(1); // unscanned
      expect(JSON.parse(runScanCommand(['--json'], { cwd: fresh }).stdout).wrote).toBe(true);
      expect(runStatusCommand([], { cwd: fresh }).exitCode).toBe(0); // clean after
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('snapshot ledger uniqueness', () => {
  function corruptSnapshot(mutate: (files: Record<string, unknown>[]) => void): void {
    const p = paths.snapshot(repo);
    const snap = parseYaml(readFileSync(p, 'utf8'));
    mutate(snap.files);
    writeFileSync(p, stringifyYaml(snap));
  }

  it('rejects an exact duplicate file path in status and scan', () => {
    corruptSnapshot((files) => files.push({ ...files[0]! }));
    expect(runStatusCommand([], ctx()).exitCode).toBe(2);
    expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);
  });

  it('rejects a conflicting duplicate file path (same path, different fields)', () => {
    corruptSnapshot((files) =>
      files.push({ ...files[0]!, size: (files[0]!.size as number) + 1, blob_hash: 'sha256:different' }),
    );
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('duplicate file path');
    expect(runScanCommand([], ctx()).exitCode).toBe(2);
  });
});

describe('stale detection ignores a stale/corrupt derived cache', () => {
  it('reports stale nodes correctly after a real branch switch leaves the cache behind', () => {
    const base = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();

    // Commit the tracked model on the base branch, then a differently-structured model on a branch.
    git('add', '-A');
    git('commit', '-m', 'archmap base');

    git('checkout', '-b', 'other');
    rmSync(join(repo, 'src/a.ts'));
    write('lib/a.ts', 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-m', 'move to lib');
    runScanCommand([], ctx()); // cache now reflects the "other" branch (lib/a.ts)
    git('add', '-A');
    git('commit', '-m', 'archmap other');

    git('checkout', base); // tracked .archmap reverts to base; ignored cache stays "other"
    write('src/a.ts', 'export const a = 999;\n'); // modify a file the base branch tracks

    const report = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(report.diff.modified).toContain('src/a.ts');
    expect(report.stale_nodes.length).toBeGreaterThan(0);
  });

  it('rebuilds correctly when the cache index is corrupt', () => {
    writeFileSync(paths.index(repo), 'not json at all');
    write('src/a.ts', 'export const a = 2;\n');
    const report = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(report.diff.modified).toContain('src/a.ts');
    expect(report.stale_nodes.length).toBeGreaterThan(0);
  });
});

describe.skipIf(skipPerm)('transactional publish (rollback on write failure)', () => {
  const nodeBytes = () =>
    readdirSync(paths.nodesDir(repo))
      .filter((e) => e.endsWith('.yaml'))
      .sort()
      .map((e) => `${e}:${readFileSync(join(paths.nodesDir(repo), e), 'utf8')}`)
      .join('|');

  it('rolls back to the byte-identical baseline when a node write fails (EACCES)', () => {
    write('src/b.ts', 'export const b = 1;\n'); // new file → scan would add a node
    const snapBefore = readFileSync(paths.snapshot(repo), 'utf8');
    const nodesBefore = nodeBytes();
    const cacheBefore = readFileSync(paths.index(repo), 'utf8');

    chmodSync(paths.nodesDir(repo), 0o555);
    try {
      const out = runScanCommand([], ctx());
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('cannot remove');
    } finally {
      chmodSync(paths.nodesDir(repo), 0o755);
    }

    // Nothing half-committed: snapshot, nodes, and cache are all byte-identical to before.
    expect(readFileSync(paths.snapshot(repo), 'utf8')).toBe(snapBefore);
    expect(nodeBytes()).toBe(nodesBefore);
    expect(readFileSync(paths.index(repo), 'utf8')).toBe(cacheBefore);

    // The old baseline is still readable and reports the new file as stale.
    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(status.scanned).toBe(true);
    expect(status.diff.added).toContain('src/b.ts');
    expect(status.stale_nodes.length).toBeGreaterThan(0);
  });
});

describe('capability identity uniqueness', () => {
  function setCapabilities(caps: unknown[]): void {
    const p = paths.snapshot(repo);
    const snap = parseYaml(readFileSync(p, 'utf8'));
    snap.capabilities = caps;
    writeFileSync(p, stringifyYaml(snap));
  }

  it('does not treat colliding-concatenation identities as duplicates', () => {
    setCapabilities([
      { id: 'a@', version: 'b', status: 'supported' },
      { id: 'a', version: '@b', status: 'supported' },
    ]);
    const out = runStatusCommand([], ctx());
    expect(out.stderr).not.toContain('duplicate capability');
  });

  it('rejects a truly duplicate capability identity', () => {
    setCapabilities([
      { id: 'a', version: 'b', status: 'supported' },
      { id: 'a', version: 'b', status: 'supported' },
    ]);
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('duplicate capability');
  });
});

describe('scan --json on a generated-model validation failure', () => {
  it('emits a stable JSON report, not prose', () => {
    // The snapshot declares an extra capability and a preserved human claim cites it; the
    // regenerated model (which declares only the shipped capabilities) then rejects that
    // claim — a valid baseline that produces an invalid prospective model.
    const sp = paths.snapshot(repo);
    const snap = parseYaml(readFileSync(sp, 'utf8'));
    snap.capabilities.push({ id: 'legacy', version: '1.0.0', status: 'supported' });
    writeFileSync(sp, stringifyYaml(snap));

    const f = nodeFileFor('src/a.ts');
    const doc = parseYaml(readFileSync(f, 'utf8'));
    doc.claims = [
      ...(doc.claims ?? []),
      {
        id: 'claim_legacy',
        type: 'inference',
        text: 'legacy human note',
        status: 'active',
        confidence: 0.5,
        provenance: { actor: 'human', created_at: '2026-07-13T00:00:00Z' },
        evidence: [
          { repository: 'local', commit: 'a', path: 'src/a.ts', analyzer: 'legacy', analyzer_version: '1.0.0', blob_hash: 'sha256:x', extract_hash: 'sha256:y' },
        ],
      },
    ];
    writeFileSync(f, stringifyYaml(doc));

    const out = runScanCommand(['--json'], ctx());
    expect(out.exitCode).toBe(1);
    const report = JSON.parse(out.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.command).toBe('scan');
    expect(report.wrote).toBe(false);
    expect(Array.isArray(report.errors)).toBe(true);
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

describe.skipIf(skipPerm)('unreadable source input fails closed', () => {
  it('treats an unreadable file as a scan error, not a deletion, and preserves the model', () => {
    write('src/b.ts', 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-m', 'b');
    runScanCommand([], ctx());
    const snapBefore = readFileSync(paths.snapshot(repo), 'utf8');

    chmodSync(join(repo, 'src/b.ts'), 0o000);
    try {
      const st = runStatusCommand([], ctx());
      expect(st.exitCode).toBe(2);
      expect(st.stderr).toContain('cannot open source file');
      expect(runScanCommand([], ctx()).exitCode).toBe(2);
      expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);
      expect(readFileSync(paths.snapshot(repo), 'utf8')).toBe(snapBefore);
    } finally {
      chmodSync(join(repo, 'src/b.ts'), 0o644);
    }
    // Recovered: the old baseline reads cleanly again.
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
  });

  it('fails closed on an unreadable directory in the filesystem walk (non-git)', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-walk-')));
    try {
      writeFileSync(join(fresh, 'a.py'), 'x\n');
      mkdirSync(join(fresh, 'sub'));
      writeFileSync(join(fresh, 'sub', 'b.py'), 'y\n');
      runInit([], { cwd: fresh });
      runScanCommand([], { cwd: fresh });

      chmodSync(join(fresh, 'sub'), 0o000);
      try {
        const out = runScanCommand([], { cwd: fresh });
        expect(out.exitCode).toBe(2);
        expect(out.stderr).toContain('cannot list directory');
      } finally {
        chmodSync(join(fresh, 'sub'), 0o755);
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipPerm)('git failure in a git repo fails closed (no unfiltered walk)', () => {
  it('does not fall back to a .gitignore-ignoring walk when git is broken', () => {
    write('.gitignore', 'private.txt\n');
    write('private.txt', 'SECRET\n');
    git('add', '-A');
    git('commit', '-m', 'ignore');
    runScanCommand([], ctx());
    // git-ignored → never in the snapshot
    expect(readFileSync(paths.snapshot(repo), 'utf8')).not.toContain('private.txt');
    const stateBefore = trackedStateHash();

    chmodSync(join(repo, '.git', 'index'), 0o000);
    try {
      const st = runStatusCommand([], ctx());
      expect(st.exitCode).toBe(2);
      expect(st.stderr).toMatch(/git (ls-files|status) failed/);
      expect(runScanCommand([], ctx()).exitCode).toBe(2);
      expect(runScanCommand(['--changed'], ctx()).exitCode).toBe(2);
      expect(trackedStateHash()).toBe(stateBefore); // nothing written
    } finally {
      chmodSync(join(repo, '.git', 'index'), 0o644);
    }
    // Recovered, and the ignored file never entered the model.
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
    expect(readFileSync(paths.snapshot(repo), 'utf8')).not.toContain('private.txt');
  });
});

describe('symlinked .archmap is refused consistently (init and status)', () => {
  it('fails closed when .archmap is a symlink to an external project', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-symarch-')));
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-symtarget-')));
    try {
      spawnSync('git', ['init'], { cwd: fresh });
      mkdirSync(join(target, 'real'));
      writeFileSync(
        join(target, 'real', 'project.yaml'),
        'schema_version: 1\nproject:\n  id: x\n  name: y\nscan:\n  max_file_bytes: 1\n  exclude_dirs: []\n  secret_globs: []\n',
      );
      symlinkSync(join(target, 'real'), join(fresh, '.archmap'));

      const initOut = runInit([], { cwd: fresh });
      expect(initOut.exitCode).toBe(2);
      expect(initOut.stderr).toContain('refusing to follow symlink');

      const statusOut = runStatusCommand([], { cwd: fresh });
      expect(statusOut.exitCode).toBe(2);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('max_file_bytes is enforced by bytes read (size stays consistent with the hash)', () => {
  it('accepts a file at the limit and excludes one over it', () => {
    const pf = paths.project(repo);
    const proj = parseYaml(readFileSync(pf, 'utf8'));
    proj.scan.max_file_bytes = 10;
    writeFileSync(pf, stringifyYaml(proj));

    write('ten.txt', '0123456789'); // exactly 10 bytes
    write('eleven.txt', '0123456789X'); // 11 bytes
    git('add', '-A');
    git('commit', '-m', 'sizes');
    runScanCommand([], ctx());

    const snap = parseYaml(readFileSync(paths.snapshot(repo), 'utf8'));
    const ten = snap.files.find((f: { path: string }) => f.path === 'ten.txt');
    expect(ten.size).toBe(10); // size == bytes actually read/hashed
    expect(snap.files.some((f: { path: string }) => f.path === 'eleven.txt')).toBe(false);
    expect(snap.excluded_counts['too-large']).toBeGreaterThanOrEqual(1);
  });

  it('honors the boundary at max_file_bytes: 0 (empty accepted, one byte too-large)', () => {
    const pf = paths.project(repo);
    const proj = parseYaml(readFileSync(pf, 'utf8'));
    proj.scan.max_file_bytes = 0;
    writeFileSync(pf, stringifyYaml(proj));

    write('empty.txt', ''); // 0 bytes
    write('one.txt', 'x'); // 1 byte
    git('add', '-A');
    git('commit', '-m', 'boundary');
    runScanCommand([], ctx());

    const snap = parseYaml(readFileSync(paths.snapshot(repo), 'utf8'));
    const empty = snap.files.find((f: { path: string }) => f.path === 'empty.txt');
    expect(empty.size).toBe(0);
    expect(snap.files.some((f: { path: string }) => f.path === 'one.txt')).toBe(false);
  });
});
