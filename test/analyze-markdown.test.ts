import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeMarkdownDocuments } from '../src/analyze/markdown.js';
import { analyzeModules } from '../src/analyze/model.js';
import { analyzePythonModules } from '../src/analyze/python-model.js';
import { probePythonWorker } from '../src/analyze/python-worker.js';
import { buildNodes, nodeId } from '../src/scan/nodes.js';
import { classify } from '../src/scan/classify.js';
import { hashContent } from '../src/scan/hash.js';
import { toCanonicalJson } from '../src/model/canonical.js';
import { validateManifest } from '../src/validate/validate.js';
import type { Discovery } from '../src/scan/types.js';
import { ADAPTER_REGISTRY, getAdapterRegistry, MARKDOWN_CAPABILITY } from '../src/capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'fixtures', 'docs-repo');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'golden.nodes.json') out.push(path);
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

function analyzeDocSources(sources: Record<string, string>) {
  const files = Object.entries(sources).map(([path, source]) => {
    const content = Buffer.from(source);
    return { path, blob_hash: hashContent(content), size: content.length, category: classify(path) };
  });
  const discovery: Discovery = {
    root: 'fixture',
    base_commit: null,
    dirty: false,
    git_available: false,
    files,
    excluded_counts: { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 },
    contents: new Map(Object.entries(sources).map(([path, source]) => [path, Buffer.from(source)])),
  };
  return analyzeMarkdownDocuments(discovery, buildNodes(files, 'fixture')).nodes;
}

function readmeDestinations(sources: Record<string, string>): string[] {
  const readme = analyzeDocSources(sources).find((node) => node.scope?.files?.[0] === 'README.md')!;
  return readme.relations.map((relation) => relation.evidence?.[0]?.symbol ?? '').sort();
}

describe('Markdown docs adapter', () => {
  const discovery = fixtureDiscovery();
  const pythonRuntime = probePythonWorker();
  if (pythonRuntime.status !== 'available') throw new Error('Markdown fixture tests require Python targeting');
  const structural = buildNodes(discovery.files, 'docs-repo');
  const python = analyzePythonModules(discovery, {
    ...pythonRuntime,
    analyzerVersion: '0.1.0+python-fixture',
  });
  const languageNodes = [
    ...analyzeModules(discovery),
    ...python.nodes,
  ];
  const result = analyzeMarkdownDocuments(discovery, [...structural, ...languageNodes]);

  it('matches the predefined canonical fixture golden byte-for-byte', () => {
    expect(toCanonicalJson(result.nodes)).toBe(readFileSync(join(fixtureRoot, 'golden.nodes.json'), 'utf8'));
  });

  it('extracts front-matter-safe title and visible ATX heading structure', () => {
    const readme = result.nodes.find((node) => node.title === 'Architecture Docs')!;
    expect(readme.kind).toBe('store');
    expect(readme.id).toBe(nodeId('doc:README.md'));
    expect(readme.scope).toEqual({ files: ['README.md'], symbols: ['Overview'] });
    expect(readme.scope?.symbols).not.toContain('Hidden heading');
  });

  it('resolves only exact snapshot targets and preserves partial uncertainty', () => {
    const readme = result.nodes.find((node) => node.scope?.files?.[0] === 'README.md')!;
    const targets = new Map(
      readme.relations.map((relation) => [
        relation.evidence?.[0]?.symbol,
        { relation, node: [...structural, ...languageNodes, ...result.nodes].find((node) => node.id === relation.target) },
      ]),
    );
    expect(targets.get('guides/guide.md#install')?.relation.certainty).toBe('known');
    expect(targets.get('guides/guide.md#install')?.node?.kind).toBe('store');
    expect(targets.get('src/service.py')?.relation.certainty).toBe('known');
    expect(targets.get('src/service.py')?.node?.kind).toBe('module');
    expect(targets.get('assets/architecture.svg')?.relation.certainty).toBe('known');
    expect(targets.get('assets/architecture.svg')?.node?.title).toBe('assets');
    for (const unresolved of [
      'missing.md',
      'Guides/guide.md',
      'guides\\guide.md',
      'mailto:docs@example.com',
      'https://example.com/docs',
      'https://autolink.example/docs',
    ]) {
      expect(targets.get(unresolved)?.relation.certainty, unresolved).toBe('partial');
      expect(targets.get(unresolved)?.node?.kind, unresolved).toBe('external');
    }
  });

  it('masks code, omits pure anchors, and deterministically deduplicates duplicate links', () => {
    const readme = result.nodes.find((node) => node.scope?.files?.[0] === 'README.md')!;
    const symbols = readme.relations.map((relation) => relation.evidence?.[0]?.symbol);
    expect(symbols).not.toContain('hidden-inline.md');
    expect(symbols).not.toContain('hidden-fence.md');
    expect(symbols).not.toContain('malformed.md');
    expect(symbols).not.toContain('html-only.md');
    expect(symbols).not.toContain('script.js');
    expect(symbols).not.toContain('escaped.md');
    expect(symbols).not.toContain('https://escaped.example/docs');
    expect(symbols).not.toContain('hidden-multiline.md');
    expect(symbols.filter((symbol) => symbol === 'guides/guide.md#install')).toHaveLength(1);
    const guide = result.nodes.find((node) => node.scope?.files?.[0] === 'guides/guide.md')!;
    expect(guide.relations.some((relation) => relation.evidence?.[0]?.symbol === '#install')).toBe(false);
  });

  it('emits only path-convention decision/ledger facts with navigable evidence', () => {
    const decision = result.nodes.find((node) => node.scope?.files?.[0] === 'decisions/ADR-0001.md')!;
    const ledger = result.nodes.find((node) => node.scope?.files?.[0] === 'ledger/2026.md')!;
    expect(decision.claims.map((claim) => claim.text)).toEqual([
      'Decision record (path convention: ADR filename in decisions directory).',
    ]);
    expect(ledger.claims.map((claim) => claim.text)).toEqual([
      'Ledger asset (path convention: ledger directory).',
    ]);
    expect([...decision.claims, ...ledger.claims].every((claim) => claim.evidence.length > 0)).toBe(true);
  });

  it('is deterministic, evidence-complete, target-complete, and manifest-valid', () => {
    expect(analyzeMarkdownDocuments(discovery, [...structural, ...languageNodes])).toEqual(result);
    const nodes = [...structural, ...languageNodes, ...result.nodes];
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of result.nodes) {
      for (const claim of node.claims) expect(claim.evidence.length).toBeGreaterThan(0);
      for (const relation of node.relations) {
        expect(relation.evidence?.length ?? 0).toBeGreaterThan(0);
        expect(ids.has(relation.target)).toBe(true);
      }
    }
    expect(validateManifest({
      schema_version: 1,
      capabilities: [python.capability, result.capability],
      nodes,
    })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('keeps every public Markdown capability surface aligned with emitted evidence', () => {
    expect(result.capability).toEqual(MARKDOWN_CAPABILITY);
    expect(ADAPTER_REGISTRY.find((capability) => capability.id === 'markdown')).toEqual(result.capability);
    expect(getAdapterRegistry().find((capability) => capability.id === 'markdown')).toEqual(result.capability);
    const emitted = result.nodes.flatMap((node) => [
      ...node.claims.flatMap((claim) => claim.evidence),
      ...node.relations.flatMap((relation) => relation.evidence ?? []),
    ]);
    expect(emitted.every((entry) => entry.analyzer === 'markdown' && entry.analyzer_version === result.capability.version)).toBe(true);
  });

  it('does not rescan link-like text inside an inline-link title', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n[outer](real.md "[inner](fake.md)")\n',
      'real.md': '# Real\n',
      'fake.md': '# Fake\n',
    })).toEqual(['real.md']);
  });

  it('does not rescan autolink-like text inside an inline-link title', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n[outer](real.md "<https://title.example>")\n',
      'real.md': '# Real\n',
    })).toEqual(['real.md']);
  });

  it('still extracts valid adjacent inline links and autolinks', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n[outer](real.md "title")[adjacent](fake.md) <https://adjacent.example>\n',
      'real.md': '# Real\n',
      'fake.md': '# Fake\n',
    })).toEqual(['fake.md', 'https://adjacent.example', 'real.md']);
  });

  it('does not rescan an autolink inside a resolved reference-link label', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n[outer <https://label.example>][target]\n\n[target]: real.md\n',
      'real.md': '# Real\n',
    })).toEqual(['real.md']);
  });

  it('does not rescan an autolink inside a resolved reference-image label', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n![outer <https://image-label.example>][target]\n\n[target]: real.md\n',
      'real.md': '# Real\n',
    })).toEqual(['real.md']);
  });

  it('preserves autolinks and reference links adjacent to a resolved reference use', () => {
    expect(readmeDestinations({
      'README.md': '# Home\n\n[outer <https://hidden.example>][target]<https://adjacent.example>[next]\n\n[target]: real.md\n[next]: next.md\n',
      'real.md': '# Real\n',
      'next.md': '# Next\n',
    })).toEqual(['https://adjacent.example', 'next.md', 'real.md']);
  });
});
