import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { analyzeModules } from '../src/analyze/model.js';
import { hashContent } from '../src/scan/hash.js';
import { classify } from '../src/scan/classify.js';
import { toCanonicalJson } from '../src/model/canonical.js';
import type { Discovery } from '../src/scan/types.js';
import type { Node } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'ts-project');

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
}

/** Build a synthetic discovery from the fixture files — deterministic, no git. */
function fixtureDiscovery(): Discovery {
  const abs: string[] = [];
  walk(fixtureRoot, abs);
  const files = [];
  const contents = new Map<string, Buffer>();
  for (const a of abs.sort()) {
    const rel = relative(fixtureRoot, a).split('\\').join('/');
    const buf = readFileSync(a);
    files.push({ path: rel, blob_hash: hashContent(buf), size: buf.length, category: classify(rel) });
    contents.set(rel, buf);
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

describe('TypeScript analysis golden', () => {
  const nodes = analyzeModules(fixtureDiscovery());

  it('module + import relations reach the predefined golden', () => {
    const golden = readFileSync(join(fixtureRoot, 'golden.nodes.json'), 'utf8');
    expect(toCanonicalJson(nodes)).toBe(golden);
  });

  it('is deterministic across runs', () => {
    expect(toCanonicalJson(analyzeModules(fixtureDiscovery()))).toBe(toCanonicalJson(nodes));
  });

  it('every relation and fact is navigable to at least one evidence entry', () => {
    for (const node of nodes) {
      for (const rel of node.relations) {
        expect(rel.evidence?.length ?? 0, `relation ${rel.id} on ${node.title}`).toBeGreaterThan(0);
      }
      for (const claim of node.claims) {
        expect(claim.evidence.length, `claim ${claim.id} on ${node.title}`).toBeGreaterThan(0);
      }
    }
  });

  it('every relation target resolves to a node in the model (no dangling)', () => {
    const ids = new Set(nodes.map((n) => n.id));
    for (const node of nodes) {
      for (const rel of node.relations) {
        expect(ids.has(rel.target), `dangling ${rel.type} -> ${rel.target}`).toBe(true);
      }
    }
  });

  it('marks internal imports known and heuristic detections partial', () => {
    const byTitle = new Map(nodes.map((n) => [n.title, n]));
    const service = byTitle.get('src/service.ts')!;
    const internalImport = service.relations.find((r) => r.type === 'imports');
    expect(internalImport?.certainty).toBe('known');
    const httpCall = service.relations.find((r) => r.type === 'calls');
    expect(httpCall?.certainty).toBe('partial'); // heuristic, never promoted to a fact

    const server = byTitle.get('src/server.ts')!;
    expect(server.relations.filter((r) => r.type === 'publishes' && r.certainty === 'partial')).toHaveLength(2);
  });

  it('records an entry-point fact for a shebang module', () => {
    const run = nodes.find((n: Node) => n.title === 'bin/run.ts')!;
    const entry = run.claims.find((c) => c.type === 'fact');
    expect(entry?.text).toContain('Entry point');
    expect(entry?.provenance.actor).toBe('analyzer');
  });
});

describe('import resolution honesty (no false known-external)', () => {
  function analyze(sources: Record<string, string>): Node[] {
    const files = Object.entries(sources).map(([path, c]) => ({
      path,
      blob_hash: hashContent(Buffer.from(c)),
      size: c.length,
      category: classify(path),
    }));
    const contents = new Map(Object.entries(sources).map(([p, c]) => [p, Buffer.from(c)]));
    const discovery: Discovery = {
      root: 'r',
      base_commit: null,
      dirty: false,
      git_available: false,
      files,
      excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
      contents,
    };
    return analyzeModules(discovery);
  }

  it('resolves a tsconfig path alias to an internal module (not a known external)', () => {
    const nodes = analyze({
      'src/main.ts': "import { u } from '@app/util';\nexport const m = u;\n",
      'src/util.ts': 'export const u = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
    });
    const main = nodes.find((n) => n.title === 'src/main.ts')!;
    const rel = main.relations.find((r) => r.type === 'imports')!;
    const target = nodes.find((n) => n.id === rel.target)!;
    expect(rel.certainty).toBe('known');
    expect(target.kind).toBe('module'); // resolved to the internal module, not an external node
    expect(target.title).toBe('src/util.ts');
  });

  it('marks a declared dependency and builtin known, but an undeclared bare import partial', () => {
    const nodes = analyze({
      'src/main.ts': "import 'express';\nimport 'mystery';\nimport 'node:fs';\nexport const x = 1;\n",
      'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
    });
    const main = nodes.find((n) => n.title === 'src/main.ts')!;
    const byTargetTitle = new Map(
      main.relations
        .filter((r) => r.type === 'imports')
        .map((r) => [nodes.find((n) => n.id === r.target)!.title, r.certainty]),
    );
    expect(byTargetTitle.get('express')).toBe('known'); // declared dependency
    expect(byTargetTitle.get('node:fs')).toBe('known'); // builtin
    expect(byTargetTitle.get('mystery')).toBe('partial'); // unverifiable → not asserted external
  });

  it('honors tsconfig pattern specificity (most specific alias wins, not insertion order)', () => {
    const nodes = analyze({
      'src/main.ts': "import { s } from '@app/special/x';\nexport const m = s;\n",
      'src/generic/special/x.ts': 'export const s = 0;\n',
      'src/special/x.ts': 'export const s = 1;\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['src/generic/*'], '@app/special/*': ['src/special/*'] },
        },
      }),
    });
    const main = nodes.find((n) => n.title === 'src/main.ts')!;
    const rel = main.relations.find((r) => r.type === 'imports')!;
    const target = nodes.find((n) => n.id === rel.target)!;
    expect(rel.certainty).toBe('known');
    expect(target.title).toBe('src/special/x.ts'); // the more specific pattern, not src/generic/...
  });

  it('keeps an absolute-baseUrl alias partial (does not strip "/src/x" into repo-relative)', () => {
    const nodes = analyze({
      'src/main.ts': "import { x } from '@absolute/x';\nexport const m = x;\n",
      'src/x.ts': 'export const x = 1;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '/', paths: { '@absolute/*': ['src/*'] } } }),
    });
    const main = nodes.find((n) => n.title === 'src/main.ts')!;
    const rel = main.relations.find((r) => r.type === 'imports')!;
    const target = nodes.find((n) => n.id === rel.target)!;
    expect(rel.certainty).toBe('partial'); // absolute baseUrl → not a verifiable internal module
    expect(target.kind).toBe('external');
    expect(target.title).not.toBe('src/x.ts'); // never targets the in-repo file
  });

  it('does not clamp a repo-escaping relative import back into the repo (marks it partial)', () => {
    const nodes = analyze({
      'src/a.ts': "import { b } from '../../../src/b.js';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 1;\n',
    });
    const main = nodes.find((n) => n.title === 'src/a.ts')!;
    const rel = main.relations.find((r) => r.type === 'imports')!;
    const target = nodes.find((n) => n.id === rel.target)!;
    expect(rel.certainty).toBe('partial'); // escapes root → cannot be asserted internal
    expect(target.kind).toBe('external');
    expect(target.title).not.toBe('src/b.ts'); // never rebound to the in-repo file
  });
});
