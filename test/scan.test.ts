import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { runCapabilitiesCommand } from '../src/cli/capabilities-command.js';
import { readSnapshot, readNodes, paths } from '../src/store.js';
import { hashContent } from '../src/scan/hash.js';

let repo: string;

function git(...args: string[]): void {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function ctx() {
  return { cwd: repo };
}

beforeEach(() => {
  // realpath so the path matches `git rev-parse --show-toplevel` on macOS (/var -> /private/var).
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-scan-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('src/auth/service.ts', 'export const a = 1;\n');
  write('src/index.ts', 'export const b = 2;\n');
  write('docs/readme.md', '# Docs\n');
  write('.env', 'API_KEY=supersecret\n');
  write('blob.bin', '\x00\x01binary\x00\n');
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('init', () => {
  it('creates a project and is idempotent', () => {
    const first = runInit([], ctx());
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('initialized');

    const second = runInit([], ctx());
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('already initialized');
  });
});

describe('scan', () => {
  beforeEach(() => runInit([], ctx()));

  it('records included files and applies safe-default exclusions', () => {
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(0);

    const snapshot = readSnapshot(repo)!;
    const paths_ = snapshot.files.map((f) => f.path);
    expect(paths_).toContain('src/auth/service.ts');
    expect(paths_).toContain('docs/readme.md');
    expect(paths_).not.toContain('.env'); // secret
    expect(paths_).not.toContain('blob.bin'); // binary
    expect(paths_).not.toContain('node_modules/pkg.js'); // excluded dir
    expect(snapshot.excluded_counts.secret).toBe(1);
    expect(snapshot.excluded_counts.binary).toBe(1);
    expect(snapshot.excluded_counts['excluded-dir']).toBe(1);
  });

  it('produces byte-identical tracked output on a re-scan (no tracked diff)', () => {
    runScanCommand([], ctx());
    const snap1 = readFileSync(paths.snapshot(repo), 'utf8');
    const nodes1 = readNodes(repo);

    runScanCommand([], ctx());
    const snap2 = readFileSync(paths.snapshot(repo), 'utf8');
    const nodes2 = readNodes(repo);

    expect(snap2).toBe(snap1);
    expect(nodes2).toEqual(nodes1);
  });

  it('exits early on --changed when nothing changed', () => {
    runScanCommand([], ctx());
    const out = runScanCommand(['--changed', '--json'], ctx());
    const report = JSON.parse(out.stdout);
    expect(report.changed).toBe(false);
    expect(report.wrote).toBe(false);
  });
});

describe('status', () => {
  beforeEach(() => {
    runInit([], ctx());
    runScanCommand([], ctx());
  });

  it('is clean immediately after a scan', () => {
    const out = runStatusCommand(['--json'], ctx());
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).clean).toBe(true);
  });

  it('flags a modified file and its node as stale', () => {
    write('src/index.ts', 'export const b = 999;\n');
    const out = runStatusCommand(['--json'], ctx());
    expect(out.exitCode).toBe(1);
    const report = JSON.parse(out.stdout);
    expect(report.diff.modified).toContain('src/index.ts');
    expect(report.stale_nodes.length).toBeGreaterThan(0);
  });

  it('detects a rename via matching content hash', () => {
    git('mv', 'docs/readme.md', 'docs/guide.md');
    const report = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(report.diff.renamed).toEqual([{ from: 'docs/readme.md', to: 'docs/guide.md' }]);
    expect(report.diff.added).toEqual([]);
    expect(report.diff.deleted).toEqual([]);
  });

  it('detects a deletion', () => {
    rmSync(join(repo, 'docs/readme.md'));
    const report = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(report.diff.deleted).toContain('docs/readme.md');
    expect(report.stale_nodes.length).toBeGreaterThan(0);
  });

  it('reports needs-scan before any scan', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-fresh-')));
    try {
      spawnSync('git', ['init'], { cwd: fresh });
      runInit([], { cwd: fresh });
      const out = runStatusCommand(['--json'], { cwd: fresh });
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout).scanned).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('capabilities', () => {
  it('reports universal, typescript, and the available packaged Python adapter truthfully', () => {
    const out = runCapabilitiesCommand(['--json'], ctx());
    const report = JSON.parse(out.stdout);
    const byId = Object.fromEntries(report.adapters.map((a: { id: string; status: string }) => [a.id, a.status]));
    expect(byId.universal).toBe('supported');
    expect(byId.typescript).toBe('supported');
    expect(byId.python).toBe('supported');
    expect(report.environment.git).toBe(true);
  });
});

describe('stored M2 capability compatibility', () => {
  it('keeps a valid pre-Python snapshot readable against its stored capability set', () => {
    runInit([], ctx());
    runScanCommand([], ctx());
    const snapshotPath = paths.snapshot(repo);
    const snapshot = parseYaml(readFileSync(snapshotPath, 'utf8'));
    snapshot.capabilities = snapshot.capabilities.filter((capability: { id: string }) => capability.id !== 'python');
    writeFileSync(snapshotPath, stringifyYaml(snapshot));

    const out = runStatusCommand(['--json'], ctx());
    expect(out.exitCode).toBe(1); // readable but stale because this build now declares Python
    const report = JSON.parse(out.stdout);
    expect(report.scanned).toBe(true);
    expect(report.drift).toContain('snapshot-metadata');
  });
});

describe('scan without init', () => {
  it('fails with a usage error', () => {
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('archmap init');
  });
});

describe('symlink safety', () => {
  beforeEach(() => runInit([], ctx()));

  it('excludes tracked symlinks and never follows them into secrets or outside the repo', () => {
    writeFileSync(join(repo, '.env'), 'API_KEY=leak\n'); // secret, excluded by name
    symlinkSync('.env', join(repo, 'public.txt')); // alias to the secret under a benign name
    symlinkSync('/etc/hostname', join(repo, 'external.txt')); // outside the repo boundary
    symlinkSync('does-not-exist', join(repo, 'dangling.txt')); // dangling
    git('add', '-A');
    git('commit', '-m', 'links');

    runScanCommand([], ctx());
    const snap = readSnapshot(repo)!;
    const paths_ = snap.files.map((f) => f.path);

    expect(paths_).not.toContain('public.txt');
    expect(paths_).not.toContain('external.txt');
    expect(paths_).not.toContain('dangling.txt');
    expect(snap.excluded_counts.symlink).toBeGreaterThanOrEqual(3);

    // The secret's content must never appear in the snapshot under any path.
    const leakHash = hashContent(Buffer.from('API_KEY=leak\n'));
    expect(snap.files.every((f) => f.blob_hash !== leakHash)).toBe(true);
  });
});

describe('dirty working tree', () => {
  beforeEach(() => runInit([], ctx()));

  it('records base_commit + dirty and the worktree hash, not the HEAD blob', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(repo, 'src/index.ts'), 'export const b = 2222;\n'); // modify, do not commit

    runScanCommand([], ctx());
    const snap = readSnapshot(repo)!;
    expect(snap.base_commit).toBe(head);
    expect(snap.dirty).toBe(true);
    const rec = snap.files.find((f) => f.path === 'src/index.ts')!;
    expect(rec.blob_hash).toBe(hashContent(Buffer.from('export const b = 2222;\n')));
  });

  it('is dirty for an untracked included file', () => {
    writeFileSync(join(repo, 'src/extra.ts'), 'export const c = 3;\n');
    runScanCommand([], ctx());
    expect(readSnapshot(repo)!.dirty).toBe(true);
  });

  it('is not dirty on a clean committed tree', () => {
    runScanCommand([], ctx());
    expect(readSnapshot(repo)!.dirty).toBe(false);
  });
});

describe('scan --changed sensitivity', () => {
  beforeEach(() => {
    runInit([], ctx());
    runScanCommand([], ctx());
  });

  it('rewrites when project config changes a node title', () => {
    const projectPath = paths.project(repo);
    const text = readFileSync(projectPath, 'utf8').replace(/name: .*/, 'name: renamed-project');
    writeFileSync(projectPath, text);
    const out = runScanCommand(['--changed', '--json'], ctx());
    const report = JSON.parse(out.stdout);
    expect(report.changed).toBe(true);
    expect(report.wrote).toBe(true);
    const root = readNodes(repo).find((n) => n.slug === 'repository');
    expect(root?.title).toBe('renamed-project');
  });

  it('rewrites when HEAD advances even with no file content change', () => {
    git('commit', '--allow-empty', '-m', 'empty');
    const out = runScanCommand(['--changed', '--json'], ctx());
    expect(JSON.parse(out.stdout).changed).toBe(true);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    expect(readSnapshot(repo)!.base_commit).toBe(head);
  });
});

describe('status agrees with scan --changed on model currency', () => {
  beforeEach(() => {
    runInit([], ctx());
    runScanCommand([], ctx());
  });

  it('reports not-clean for a project.name change (no file change), matching scan --changed', () => {
    const p = paths.project(repo);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/name: .*/, 'name: renamed'));

    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout); // read-only first
    expect(status.clean).toBe(false);
    expect(status.drift).toContain('node-structure');
    expect(status.diff.modified).toEqual([]); // not a file change

    const changed = JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout);
    expect(status.clean).toBe(!changed.changed); // no contradiction
  });

  it('reports not-clean after an empty commit advances HEAD, matching scan --changed', () => {
    git('commit', '--allow-empty', '-m', 'empty');

    const status = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(status.clean).toBe(false);
    expect(status.drift).toContain('snapshot-metadata');

    const changed = JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout);
    expect(status.clean).toBe(!changed.changed);
  });
});

describe('added-file staleness', () => {
  beforeEach(() => {
    runInit([], ctx());
    runScanCommand([], ctx());
  });

  it('marks the containing module and repository root stale for a new file', () => {
    writeFileSync(join(repo, 'src/new.ts'), 'export const n = 1;\n');
    const report = JSON.parse(runStatusCommand(['--json'], ctx()).stdout);
    expect(report.diff.added).toContain('src/new.ts');
    expect(report.stale_nodes.length).toBeGreaterThan(0);
  });
});

describe('persisted-contract validation', () => {
  beforeEach(() => {
    runInit([], ctx());
    runScanCommand([], ctx());
  });

  it('rejects an unsupported project schema_version', () => {
    writeFileSync(
      paths.project(repo),
      'schema_version: 2\nproject:\n  id: x\n  name: y\nscan:\n  max_file_bytes: 1\n  exclude_dirs: []\n  secret_globs: []\n',
    );
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unsupported project.yaml schema_version 2');
  });

  it('rejects an unsupported snapshot schema_version', () => {
    const text = readFileSync(paths.snapshot(repo), 'utf8').replace('schema_version: 1', 'schema_version: 2');
    writeFileSync(paths.snapshot(repo), text);
    const out = runStatusCommand([], ctx());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unsupported snapshot.yaml schema_version 2');
  });

  it('rejects malformed project YAML', () => {
    writeFileSync(paths.project(repo), 'schema_version: 1\nproject: [oops\n');
    const out = runScanCommand([], ctx());
    expect(out.exitCode).toBe(2);
  });
});

describe('cache gitignore', () => {
  it('keeps the derived cache out of git while tracking project/snapshot/nodes', () => {
    runInit([], ctx());
    runScanCommand([], ctx());
    expect(existsSync(join(repo, '.archmap', '.gitignore'))).toBe(true);

    const ignored = (rel: string) =>
      spawnSync('git', ['check-ignore', rel], { cwd: repo }).status === 0;
    expect(ignored('.archmap/cache/index.json')).toBe(true);
    expect(ignored('.archmap/project.yaml')).toBe(false);
    expect(ignored('.archmap/snapshot.yaml')).toBe(false);
  });
});

describe('argument validation', () => {
  beforeEach(() => runInit([], ctx()));

  it('rejects a misspelled flag on init without initializing', () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-arg-')));
    try {
      spawnSync('git', ['init'], { cwd: fresh });
      const out = runInit(['--jso'], { cwd: fresh });
      expect(out.exitCode).toBe(2);
      expect(existsSync(join(fresh, '.archmap'))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('rejects unexpected positionals on no-arg commands', () => {
    runScanCommand([], ctx());
    expect(runScanCommand(['extra'], ctx()).exitCode).toBe(2);
    expect(runStatusCommand(['extra'], ctx()).exitCode).toBe(2);
    expect(runCapabilitiesCommand(['extra'], ctx()).exitCode).toBe(2);
  });
});
