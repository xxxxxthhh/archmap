import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { computeModelHash } from '../src/proposal/fingerprint.js';
import { readTrackedBaseline } from '../src/scan/baseline.js';

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
    expect(res.stdout).toContain('work-items');
    expect(res.stdout).toContain('search <query>');
    expect(res.stdout).toContain('proposal validate');
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
  }, 15_000);

  it('dispatches work-items and search through the real bin', () => {
    writeFileSync(join(dir, 'service.ts'), 'export const service = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'service'], { cwd: dir });
    expect(run(['init'], dir).status).toBe(0);
    expect(run(['scan'], dir).status).toBe(0);

    const workItems = run(['work-items', '--json'], dir);
    expect(workItems.status).toBe(0);
    expect(JSON.parse(workItems.stdout)).toMatchObject({ schema_version: 1, command: 'work-items', items: [] });

    const search = run(['search', 'repository', '--json'], dir);
    expect(search.status).toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({ schema_version: 1, command: 'search', found: true });
  }, 15_000);

  it('dispatches proposal validate, preview, apply, evidence, and rescan through the real bin', () => {
    writeFileSync(join(dir, 'service.ts'), 'export const service = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'service'], { cwd: dir });
    expect(run(['init'], dir).status).toBe(0);
    expect(run(['scan'], dir).status).toBe(0);

    const baseline = readTrackedBaseline(dir)!;
    const node = baseline.nodes.find((entry) => entry.scope?.files?.includes('service.ts'))!;
    const file = baseline.snapshot.files.find((entry) => entry.path === 'service.ts')!;
    const capability = baseline.snapshot.capabilities.find((entry) => entry.status === 'supported')!;
    const evidence = {
      repository: 'local',
      commit: baseline.snapshot.base_commit!,
      path: file.path,
      analyzer: capability.id,
      analyzer_version: capability.version,
      blob_hash: file.blob_hash,
      extract_hash: `sha256:${'0'.repeat(64)}`,
    };
    const proposal = {
      proposal_schema_version: 1,
      base_commit: baseline.snapshot.base_commit,
      model_hash: computeModelHash(baseline),
      operations: [
        {
          op: 'add',
          target: { class: 'claim', node_id: node.id },
          value: {
            id: 'claim_proposed',
            type: 'inference',
            text: 'Proposal CLI dispatch',
            status: 'active',
            confidence: 0.8,
            provenance: { actor: 'agent', model: 'test', created_at: '2026-07-14T00:00:00Z' },
            evidence: [evidence],
          },
        },
      ],
    };
    writeFileSync(join(dir, 'proposal.yaml'), stringifyYaml(proposal));

    const validate = run(['proposal', 'validate', 'proposal.yaml', '--json'], dir);
    const preview = run(['proposal', 'preview', 'proposal.yaml', '--json'], dir);
    expect(validate.status, `${validate.stdout}\n${validate.stderr}`).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ command: 'proposal validate', verdict: 'valid' });
    expect(preview.status, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ command: 'proposal preview', verdict: 'valid' });
    expect(JSON.parse(preview.stdout).diff).toHaveLength(1);

    const apply = run(['proposal', 'apply', 'proposal.yaml', '--json'], dir);
    expect(apply.status, `${apply.stdout}\n${apply.stderr}`).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({ command: 'proposal apply', verdict: 'applied' });

    const evidenceResult = run(['evidence', 'claim_proposed', '--json'], dir);
    expect(evidenceResult.status).toBe(0);
    expect(JSON.parse(evidenceResult.stdout)).toMatchObject({ found: true, matched: 'claim' });
    expect(run(['scan', '--changed', '--json'], dir).status).toBe(0);

    const repeated = run(['proposal', 'apply', 'proposal.yaml', '--json'], dir);
    expect(repeated.status).toBe(1);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ verdict: 'invalid' });
    const unknown = run(['proposal', 'apply', 'proposal.yaml', '--approv', 'x', '--json'], dir);
    expect(unknown.status).toBe(2);
  }, 30_000);

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
