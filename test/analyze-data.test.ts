import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDataAssets } from '../src/analyze/data.js';
import { analyzePythonModules } from '../src/analyze/python-model.js';
import { probePythonWorker } from '../src/analyze/python-worker.js';
import { DATA_CAPABILITY } from '../src/capabilities.js';
import { toCanonicalJson } from '../src/model/canonical.js';
import { classify } from '../src/scan/classify.js';
import {
  buildExclusionRules,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SECRET_GLOBS,
  excludeByName,
} from '../src/scan/exclude.js';
import { hashContent } from '../src/scan/hash.js';
import type { Discovery, ProjectConfig } from '../src/scan/types.js';
import { validateManifest } from '../src/validate/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'data-repo');
const scanConfig: ProjectConfig['scan'] = {
  max_file_bytes: DEFAULT_MAX_FILE_BYTES,
  exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
  secret_globs: [...DEFAULT_SECRET_GLOBS],
};

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'golden.nodes.json') out.push(path);
  }
}

function fixtureDiscovery(): Discovery {
  const absolute: string[] = [];
  const rules = buildExclusionRules(scanConfig);
  walk(fixtureRoot, absolute);
  const files = [];
  const contents = new Map<string, Buffer>();
  for (const path of absolute.sort()) {
    const rel = relative(fixtureRoot, path).split('\\').join('/');
    if (excludeByName(rel, rules)) continue;
    const content = readFileSync(path);
    if (content.length > scanConfig.max_file_bytes) continue;
    files.push({ path: rel, blob_hash: hashContent(content), size: content.length, category: classify(rel) });
    contents.set(rel, content);
  }
  return {
    root: fixtureRoot,
    base_commit: 'fixture-commit',
    dirty: false,
    git_available: false,
    files,
    excluded_counts: { 'excluded-dir': 0, secret: 1, 'too-large': 0, binary: 0, symlink: 0 },
    contents,
  };
}

describe('YAML/JSON data adapter', () => {
  const discovery = fixtureDiscovery();
  const result = analyzeDataAssets(discovery, scanConfig);

  it('matches the canonical fixture golden byte-for-byte', () => {
    expect(toCanonicalJson(result.nodes)).toBe(readFileSync(join(fixtureRoot, 'golden.nodes.json'), 'utf8'));
  });

  it('creates one stable store per included non-manifest asset and keeps invalid YAML node-only', () => {
    expect(result.nodes.map((node) => node.scope?.files?.[0])).toEqual([
      'config/settings.json',
      'data/input.yaml',
      'data/invalid.yaml',
      'data/output.json',
    ]);
    expect(result.nodes.every((node) => node.kind === 'store')).toBe(true);
    expect(result.nodes.find((node) => node.title === 'data/invalid.yaml')?.claims).toEqual([]);
    expect(result.nodes.some((node) => node.title === 'package.json')).toBe(false);
    expect(result.nodes.some((node) => node.title === 'config/.env.json')).toBe(false);
    expect(analyzeDataAssets({ ...discovery, files: [...discovery.files].reverse() }, scanConfig)).toEqual(result);
  });

  it('sorts and caps top-level keys without leaking any values', () => {
    const input = result.nodes.find((node) => node.title === 'data/input.yaml')!;
    expect(input.claims).toHaveLength(1);
    expect(input.claims[0]?.text).toContain(
      Array.from({ length: 20 }, (_, index) => `key${String(index + 1).padStart(2, '0')}`).join(', '),
    );
    expect(input.claims[0]?.text).not.toContain('key21');
    const serialized = JSON.stringify(result.nodes);
    for (const value of [
      'INPUT_VALUE_CANARY',
      'CONFIG_VALUE_CANARY',
      'OUTPUT_VALUE_CANARY',
      'INVALID_VALUE_CANARY',
      'MANIFEST_VALUE_CANARY',
      'SECRET_PATH_VALUE_CANARY',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('advertises only deterministic data node/structure outputs and validates provenance', () => {
    expect(result.capability).toEqual(DATA_CAPABILITY);
    expect(result.capability).toEqual({
      id: 'data',
      version: '0.1.0',
      status: 'supported',
      provides: ['yaml-json-assets', 'top-level-keys'],
    });
    expect(validateManifest({ schema_version: 1, capabilities: [result.capability], nodes: result.nodes })).toEqual({
      valid: true,
      errors: [],
    });
    expect(result.nodes.flatMap((node) => node.claims).every((claim) => claim.evidence.length === 1)).toBe(true);
  });

  it('uses working-tree evidence identity and defensively rechecks precedence, secrets, and size', () => {
    const dirty = analyzeDataAssets({ ...discovery, dirty: true }, scanConfig);
    expect(dirty.nodes.flatMap((node) => node.claims).every((claim) => claim.evidence[0]?.commit === 'working-tree')).toBe(true);

    const sources = new Map([
      ['safe.json', Buffer.from('{}')],
      ['package.json', Buffer.from('{}')],
      ['.env.json', Buffer.from('{}')],
      ['large.yaml', Buffer.from('123456789')],
    ]);
    const synthetic: Discovery = {
      root: 'fixture',
      base_commit: null,
      dirty: false,
      git_available: false,
      files: [...sources].map(([path, content]) => ({
        path,
        blob_hash: hashContent(content),
        size: content.length,
        category: 'config',
      })),
      excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
      contents: sources,
    };
    expect(analyzeDataAssets(synthetic, { ...scanConfig, max_file_bytes: 8 }).nodes.map((node) => node.title)).toEqual([
      'safe.json',
    ]);
  });
});

describe('Python literal YAML/JSON references', () => {
  function relationsForSource(source: string, targetPath = 'input.yaml') {
    const sources = new Map([
      ['builder.py', Buffer.from(source)],
      [targetPath, Buffer.from('key: value\n')],
    ]);
    const discovery: Discovery = {
      root: 'fixture',
      base_commit: null,
      dirty: false,
      git_available: false,
      files: [...sources].map(([path, content]) => ({
        path,
        blob_hash: hashContent(content),
        size: content.length,
        category: classify(path),
      })),
      excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
      contents: sources,
    };
    const data = analyzeDataAssets(discovery, scanConfig);
    const runtime = probePythonWorker();
    if (runtime.status !== 'available') throw new Error('Python data-flow tests require the packaged worker');
    const python = analyzePythonModules(discovery, runtime, data.nodes);
    return python.nodes.find((node) => node.title === 'builder.py')!.relations.filter((relation) =>
      ['reads', 'writes', 'depends-on'].includes(relation.type));
  }

  it.each([
    ['os.path.join', 'import os\nos.path.join("data", "input.yaml")\n'],
    ['Path.joinpath', 'from pathlib import Path\nPath("data").joinpath("input.yaml")\n'],
    ['imported os.path.join', 'from os.path import join\njoin("data", "input.yaml")\n'],
    ['posixpath.join', 'import posixpath\nposixpath.join("data", "input.yaml")\n'],
    ['multi-component Path', 'from pathlib import Path\nPath("data", "input.yaml")\n'],
  ])('does not treat a component literal inside %s as a bare data reference', (_name, source) => {
    expect(relationsForSource(source)).toEqual([]);
  });

  it.each([
    ['literal-receiver format', 'name = "actual"\n"data/{}.yaml".format(name)\n', 'data/{}.yaml'],
    ['empty-separator str.join', '"".join(["data/", "input.yaml"])\n', 'input.yaml'],
    ['slash-separator str.join', '"/".join(["data", "input.yaml"])\n', 'input.yaml'],
  ])('does not treat a literal inside %s as a bare data reference', (_name, source, targetPath) => {
    expect(relationsForSource(source, targetPath)).toEqual([]);
  });

  it('emits the exact conservative partial edge matrix and no guessed path edges', () => {
    const discovery = fixtureDiscovery();
    const data = analyzeDataAssets(discovery, scanConfig);
    const runtime = probePythonWorker();
    if (runtime.status !== 'available') throw new Error('Python data-flow tests require the packaged worker');
    const python = analyzePythonModules(discovery, runtime, data.nodes);
    const transform = python.nodes.find((node) => node.title === 'transform.py')!;
    const targets = new Map(data.nodes.map((node) => [node.id, node.title]));
    const dataRelations = transform.relations
      .filter((relation) => ['reads', 'writes', 'depends-on'].includes(relation.type))
      .map((relation) => ({
        type: relation.type,
        certainty: relation.certainty,
        target: targets.get(relation.target),
        analyzer: relation.evidence?.[0]?.analyzer,
      }));
    expect(dataRelations).toEqual([
      { type: 'depends-on', certainty: 'partial', target: 'config/settings.json', analyzer: 'python' },
      { type: 'reads', certainty: 'partial', target: 'data/input.yaml', analyzer: 'python' },
      { type: 'writes', certainty: 'partial', target: 'data/output.json', analyzer: 'python' },
    ]);
    expect(transform.relations.some((relation) => targets.get(relation.target) === 'data/invalid.yaml')).toBe(false);
    expect(transform.relations.every((relation) => relation.evidence?.length === 1)).toBe(true);

    const allNodes = [...data.nodes, ...python.nodes];
    expect(validateManifest({
      schema_version: 1,
      capabilities: [data.capability, python.capability],
      nodes: allNodes,
    })).toEqual({ valid: true, errors: [] });
  });
});
