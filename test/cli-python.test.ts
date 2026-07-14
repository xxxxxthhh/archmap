import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
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
import { parse as parseYaml } from 'yaml';

import { runContextCommand } from '../src/cli/context-command.js';
import { runEvidenceCommand } from '../src/cli/evidence-command.js';
import { runImpactCommand } from '../src/cli/impact-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runStatusCommand } from '../src/cli/status-command.js';
import { paths, readNodes, readSnapshot } from '../src/store.js';

let repo: string;
const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const ctx = () => ({ cwd: repo });

function write(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function nodeIdByTitle(title: string): string {
  const node = readNodes(repo).find((candidate) => candidate.title === title);
  if (!node) throw new Error(`missing node ${title}`);
  return node.id;
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

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-python-')));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('pyproject.toml', '[project]\nname="sample"\ndependencies=["requests>=2"]\n');
  write('app/__init__.py', '');
  write('app/util.py', 'class Utility:\n    pass\n');
  write(
    'app/service.py',
    [
      'import requests',
      'from .util import Utility',
      '',
      'def build():',
      '    return Utility()',
      '',
      'if __name__ == "__main__":',
      '    build()',
      '',
    ].join('\n'),
  );
  write('app/main.py', 'from .service import build\n\nbuild()\n');
  write('tests/test_service.py', 'from app.service import build\n\ndef test_build():\n    assert build\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  expect(runInit([], ctx()).exitCode).toBe(0);
  expect(runScanCommand([], ctx()).exitCode).toBe(0);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('Python scan/query vertical slice', () => {
  it('is byte-stable and status/changed agree after an unchanged rescan', () => {
    const before = trackedBytes();
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(trackedBytes()).toBe(before);
    expect(runStatusCommand([], ctx()).exitCode).toBe(0);
    expect(JSON.parse(runScanCommand(['--changed', '--json'], ctx()).stdout).changed).toBe(false);
  });

  it('supports context reasons/budget, transitive impact, and evidence lookup', () => {
    const context = JSON.parse(runContextCommand(['app/service.py', '--json'], ctx()).stdout);
    expect(context.used_tokens).toBeLessThanOrEqual(context.budget);
    const reasons = new Map(
      context.included.map((entry: { node: { title: string }; reason: string }) => [entry.node.title, entry.reason]),
    );
    expect(reasons.get('app/service.py')).toContain('target');
    expect(reasons.get('app/util.py')).toContain('imported by');
    expect(reasons.get('app/main.py')).toContain('imports the requested file');

    const impact = JSON.parse(runImpactCommand(['app/util.py', '--json'], ctx()).stdout);
    const impacted = new Set(impact.impacted.map((entry: { title: string }) => entry.title));
    expect(impacted.has('app/service.py')).toBe(true);
    expect(impacted.has('app/main.py')).toBe(true);

    const evidence = JSON.parse(runEvidenceCommand([nodeIdByTitle('app/service.py'), '--json'], ctx()).stdout);
    expect(evidence.found).toBe(true);
    expect(evidence.evidence.every((entry: { analyzer: string }) => entry.analyzer === 'python')).toBe(true);
  });

  it('uses working-tree evidence identity after a dirty scan', () => {
    write('app/service.py', 'def changed():\n    return 1\n');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    expect(readSnapshot(repo)?.dirty).toBe(true);
    const node = parseYaml(
      readFileSync(join(paths.nodesDir(repo), `${nodeIdByTitle('app/service.py')}.yaml`), 'utf8'),
    );
    expect(node.scope.symbols).toContain('changed');
    // No import remains, so add a parser-confirmed entry fact to make evidence observable.
    write('app/service.py', 'def changed():\n    return 1\n\nif __name__ == "__main__":\n    changed()\n');
    expect(runScanCommand([], ctx()).exitCode).toBe(0);
    const rescanned = parseYaml(
      readFileSync(join(paths.nodesDir(repo), `${nodeIdByTitle('app/service.py')}.yaml`), 'utf8'),
    );
    expect(rescanned.claims[0].evidence[0].commit).toBe('working-tree');
  });
});

describe('Python worker degradation', () => {
  it('reports unsupported and preserves universal scanning when the runtime is absent', () => {
    const previous = process.env.ARCHMAP_PYTHON;
    process.env.ARCHMAP_PYTHON = join(repo, 'missing-python');
    try {
      expect(runScanCommand([], ctx()).exitCode).toBe(0);
      expect(readSnapshot(repo)?.capabilities.find((capability) => capability.id === 'python')?.status).toBe(
        'unsupported',
      );
      expect(readNodes(repo).some((node) => node.kind === 'system')).toBe(true);
      expect(readNodes(repo).some((node) => node.title === 'app/service.py' && node.kind === 'module')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ARCHMAP_PYTHON;
      else process.env.ARCHMAP_PYTHON = previous;
    }
  });

  it('fails closed on malformed worker output without changing tracked bytes', () => {
    const malformed = join(repo, 'malformed-worker.py');
    writeFileSync(malformed, 'print("not-json")\n');
    const before = trackedBytes();
    const previous = process.env.ARCHMAP_PYTHON_WORKER;
    process.env.ARCHMAP_PYTHON_WORKER = malformed;
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
