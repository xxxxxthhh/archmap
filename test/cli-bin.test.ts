import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Exercise the real bin entry point end-to-end (dispatch + exit-code mapping) by running the
// source through tsx, the same code path the published `archmap` binary uses. tsx is resolved
// by absolute URL because the subprocess runs in a temp repo with no node_modules of its own.
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', TSX_IMPORT, BIN, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-bin-')));
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('archmap bin', () => {
  it('exits 2 on an unknown command', () => {
    const res = run(['frobnicate'], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown command');
  });

  it('prints usage and exits 0 for --help', () => {
    const res = run(['--help'], dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Commands:');
  });

  it('exits 2 on a misspelled flag and does not initialize', () => {
    const res = run(['init', '--jso'], dir);
    expect(res.status).toBe(2);
    expect(existsSync(join(dir, '.archmap'))).toBe(false);
  });

  it('runs the init -> scan -> status loop with real exit codes', () => {
    expect(run(['init'], dir).status).toBe(0);
    expect(run(['scan'], dir).status).toBe(0);
    expect(run(['status'], dir).status).toBe(0);
  });

  it('does not print a stack trace for a regex-metacharacter secret glob (--json)', () => {
    writeFileSync(join(dir, 'a.py'), 'x\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'a'], { cwd: dir });
    expect(run(['init'], dir).status).toBe(0);

    const pf = join(dir, '.archmap', 'project.yaml');
    const proj = parseYaml(readFileSync(pf, 'utf8'));
    proj.scan.secret_globs = ['?']; // valid config; must not crash the matcher
    writeFileSync(pf, stringifyYaml(proj));

    const res = run(['scan', '--json'], dir);
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).not.toMatch(/\n\s+at /); // no stack frames
  });

  it('handles prototype-polluting file names without crashing or losing mappings', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      writeFileSync(join(dir, name), 'x\n');
    }
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'proto'], { cwd: dir });

    expect(run(['init'], dir).status).toBe(0);
    expect(run(['scan'], dir).status).toBe(0);
    expect(run(['status'], dir).status).toBe(0);

    writeFileSync(join(dir, '__proto__'), 'changed\n');
    const res = run(['status', '--json'], dir);
    expect(res.status).toBe(1); // dirty
    const report = JSON.parse(res.stdout);
    expect(report.diff.modified).toContain('__proto__');
    expect(report.stale_nodes.length).toBeGreaterThan(0); // mapping survived
  }, 15_000);
});
