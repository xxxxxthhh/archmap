import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { analyzePythonModules } from '../src/analyze/python-model.js';
import { probePythonWorker } from '../src/analyze/python-worker.js';
import { PYTHON_CAPABILITY } from '../src/capabilities.js';
import { classify } from '../src/scan/classify.js';
import { hashContent } from '../src/scan/hash.js';
import { toCanonicalJson } from '../src/model/canonical.js';
import { validateManifest } from '../src/validate/validate.js';
import type { Discovery } from '../src/scan/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'py-project');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
}

function fixtureDiscovery(): Discovery {
  const absolute: string[] = [];
  walk(fixtureRoot, absolute);
  const files = [];
  const contents = new Map<string, Buffer>();
  for (const path of absolute.sort()) {
    const rel = relative(fixtureRoot, path).split('\\').join('/');
    const content = readFileSync(path);
    files.push({ path: rel, blob_hash: hashContent(content), size: content.length, category: classify(rel) });
    contents.set(rel, content);
  }
  return {
    root: fixtureRoot,
    base_commit: null,
    dirty: false,
    git_available: false,
    files,
    excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
    contents,
  };
}

describe('Python adapter', () => {
  const result = analyzePythonModules(fixtureDiscovery());
  const runtime = probePythonWorker();
  if (runtime.status !== 'available') throw new Error('Python fixture tests require the packaged worker');
  const goldenResult = analyzePythonModules(fixtureDiscovery(), {
    ...runtime,
    analyzerVersion: '0.1.0+python-fixture',
  });

  it('matches the predefined canonical fixture golden byte-for-byte', () => {
    const golden = readFileSync(join(fixtureRoot, 'golden.nodes.json'), 'utf8');
    expect(toCanonicalJson(goldenResult.nodes)).toBe(golden);
  });

  it('uses the native parser and emits deterministic module symbols without syntax-error lies', () => {
    expect(result.capability.status).toBe('supported');
    const byTitle = new Map(result.nodes.map((node) => [node.title, node]));
    expect(byTitle.get('pkg/__init__.py')?.scope?.symbols).toEqual(['public_api']);
    expect(byTitle.get('pkg/service.py')?.scope?.symbols).toEqual(['Service', 'build', 'health', 'serve']);
    expect(byTitle.has('broken.py')).toBe(false);
    expect(byTitle.get('pkg/service.py')?.scope?.symbols).not.toContain('nested_definition');
  });

  it('resolves internal, shadowed-stdlib, stdlib, and exact declared imports conservatively', () => {
    const service = result.nodes.find((node) => node.title === 'pkg/service.py')!;
    const targetByTitle = new Map(
      service.relations
        .filter((relation) => relation.type === 'imports')
        .map((relation) => [result.nodes.find((node) => node.id === relation.target)!.title, relation.certainty]),
    );
    expect(targetByTitle.get('pkg/util.py')).toBe('known');
    expect(targetByTitle.get('pkg/helper.py')).toBe('known');
    expect(targetByTitle.get('email.py')).toBe('known');
    expect(targetByTitle.get('os')).toBe('known');
    expect(targetByTitle.get('requests')).toBe('known');
    expect(targetByTitle.get('mystery')).toBe('partial');
    expect(targetByTitle.get('bs4')).toBe('partial');
    expect(targetByTitle.get('pkg/dynamic.py')).toBe('partial');
    expect(targetByTitle.get('dupe')).toBe('partial');
    expect(targetByTitle.has('nested_only')).toBe(false);
    expect(targetByTitle.has('fake_docstring')).toBe(false);
  });

  it('emits parser-confirmed entry/test facts and only partial CLI/route relations', () => {
    const service = result.nodes.find((node) => node.title === 'pkg/service.py')!;
    expect(service.claims.some((claim) => claim.text.includes('Entry point'))).toBe(true);
    expect(service.relations.filter((relation) => relation.type === 'publishes')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ certainty: 'partial' }),
        expect.objectContaining({ certainty: 'partial' }),
      ]),
    );
    const testModule = result.nodes.find((node) => node.title === 'tests/test_service.py')!;
    expect(testModule.claims.some((claim) => claim.text.includes('Pytest'))).toBe(true);
  });

  it('is deterministic, evidence-complete, target-complete, and manifest-valid', () => {
    const again = analyzePythonModules(fixtureDiscovery());
    expect(again).toEqual(result);
    const ids = new Set(result.nodes.map((node) => node.id));
    for (const node of result.nodes) {
      for (const claim of node.claims) expect(claim.evidence.length).toBeGreaterThan(0);
      for (const relation of node.relations) {
        expect(relation.evidence?.length ?? 0).toBeGreaterThan(0);
        expect(ids.has(relation.target)).toBe(true);
      }
    }
    expect(validateManifest({ schema_version: 1, capabilities: [result.capability], nodes: result.nodes })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('keeps the public Python capability identity aligned with emitted evidence', () => {
    expect(PYTHON_CAPABILITY).toEqual(result.capability);
    const evidence = result.nodes.flatMap((node) => [
      ...node.claims.flatMap((claim) => claim.evidence),
      ...node.relations.flatMap((relation) => relation.evidence ?? []),
    ]);
    expect(evidence.every((entry) => entry.analyzer_version === PYTHON_CAPABILITY.version)).toBe(true);
  });

  it('isolates Python startup from hostile PYTHONPATH sitecustomize code in every worker mode', () => {
    const hostile = mkdtempSync(join(tmpdir(), 'archmap-pythonpath-'));
    const sentinel = join(hostile, 'executed');
    writeFileSync(
      join(hostile, 'sitecustomize.py'),
      `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("executed")\n`,
    );
    const previous = process.env.PYTHONPATH;
    process.env.PYTHONPATH = hostile;
    try {
      const isolated = analyzePythonModules(fixtureDiscovery());
      expect(isolated.capability.status).toBe('supported');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previous;
      rmSync(hostile, { recursive: true, force: true });
    }
  });
});
