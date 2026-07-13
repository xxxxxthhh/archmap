/** Evidence-backed model projection for parser-confirmed Python analysis. */

import { hashContent } from '../scan/hash.js';
import { nodeId, slugFor } from '../scan/nodes.js';
import { ScanInputError } from '../store-errors.js';
import type { Capability, Claim, Evidence, Node, Provenance, Relation } from '../model/types.js';
import type { Discovery } from '../scan/types.js';
import { isPython } from './languages.js';
import {
  PYTHON_ADAPTER_VERSION,
  analyzeWithPythonWorker,
  declaredPythonDependencies,
  probePythonWorker,
  type PythonAnalysis,
  type PythonImport,
  type PythonWorkerState,
} from './python-worker.js';

const ANALYZER = 'python';
const PROVENANCE: Provenance = { actor: 'analyzer', created_at: '1970-01-01T00:00:00Z' };

export interface PythonModelResult {
  capability: Capability;
  nodes: Node[];
}

const supportedCapability = (version = PYTHON_ADAPTER_VERSION): Capability => ({
  id: ANALYZER,
  version,
  status: 'supported',
  provides: ['modules', 'symbols', 'imports', 'entry-points', 'pytest-tests'],
});

const unsupportedCapability = (): Capability => ({
  id: ANALYZER,
  version: PYTHON_ADAPTER_VERSION,
  status: 'unsupported',
  provides: ['modules', 'symbols', 'imports', 'entry-points', 'pytest-tests'],
});

const shortHash = (key: string): string => hashContent(Buffer.from(key)).slice('sha256:'.length, 'sha256:'.length + 16);
const moduleNodeId = (path: string): string => nodeId(`module:${path}`);
const externalNodeId = (name: string): string => nodeId(`external:python:${name}`);

function evidence(
  discovery: Discovery,
  analyzerVersion: string,
  path: string,
  extract: string,
  symbol?: string,
): Evidence {
  const file = discovery.files.find((candidate) => candidate.path === path);
  if (!file) throw new ScanInputError(`Python evidence path is absent from discovery: ${path}`);
  return {
    repository: 'local',
    commit: discovery.dirty ? 'working-tree' : (discovery.base_commit ?? 'working-tree'),
    path,
    ...(symbol ? { symbol } : {}),
    analyzer: ANALYZER,
    analyzer_version: analyzerVersion,
    blob_hash: file.blob_hash,
    extract_hash: hashContent(Buffer.from(extract)),
  };
}

function moduleName(path: string, analyzedPaths: ReadonlySet<string>): string | null {
  const parts = path.slice(0, -3).split('/');
  const isPackage = parts.at(-1) === '__init__';
  if (isPackage) parts.pop();
  // M3 deliberately does not infer namespace packages. A nested module is import-resolvable
  // only when every package directory is backed by a parsed __init__.py.
  const packageParts = parts.slice(0, -1);
  for (let index = 1; index <= packageParts.length; index += 1) {
    if (!analyzedPaths.has(`${packageParts.slice(0, index).join('/')}/__init__.py`)) return null;
  }
  return parts.length > 0 ? parts.join('.') : null;
}

function packageName(path: string, moduleNameByPath: ReadonlyMap<string, string>): string[] | null {
  const knownName = moduleNameByPath.get(path);
  if (!knownName) return null;
  const name = knownName.split('.');
  return path.endsWith('/__init__.py') ? name : name.slice(0, -1);
}

function pytestPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename.startsWith('test_') || basename.endsWith('_test.py');
}

interface Context {
  discovery: Discovery;
  moduleByName: Map<string, string>;
  moduleNameByPath: Map<string, string>;
  stdlib: ReadonlySet<string>;
  dependencies: ReadonlySet<string>;
  analyzerVersion: string;
  externals: Map<string, Node>;
}

function ensureExternal(ctx: Context, name: string): string {
  const id = externalNodeId(name);
  if (!ctx.externals.has(id)) {
    ctx.externals.set(id, { id, slug: slugFor(name), kind: 'external', title: name, claims: [], relations: [] });
  }
  return id;
}

interface ImportTarget {
  display: string;
  target: string;
  certainty: 'known' | 'partial';
}

function externalTarget(ctx: Context, specifier: string): ImportTarget {
  const root = specifier.split('.')[0] ?? specifier;
  const known = ctx.stdlib.has(root) || ctx.dependencies.has(root);
  return { display: specifier, target: ensureExternal(ctx, root), certainty: known ? 'known' : 'partial' };
}

function absoluteTarget(ctx: Context, specifier: string): ImportTarget {
  const internal = ctx.moduleByName.get(specifier);
  return internal
    ? { display: specifier, target: moduleNodeId(internal), certainty: 'known' }
    : externalTarget(ctx, specifier);
}

function relativeBase(
  importerPath: string,
  imported: PythonImport,
  moduleNameByPath: ReadonlyMap<string, string>,
): string | null {
  const pkg = packageName(importerPath, moduleNameByPath);
  if (!pkg) return null;
  const trim = imported.level - 1;
  if (trim < 0 || trim > pkg.length) return null;
  const base = pkg.slice(0, pkg.length - trim);
  if (imported.module) base.push(...imported.module.split('.'));
  return base.join('.');
}

function staticTargets(ctx: Context, importerPath: string, imported: PythonImport): ImportTarget[] {
  if (imported.level === 0) {
    if (imported.names.length === 0) return [absoluteTarget(ctx, imported.module)];
    const targets = imported.names.map((name) => {
      const child = `${imported.module}.${name}`;
      const internal = ctx.moduleByName.get(child);
      return internal
        ? { display: child, target: moduleNodeId(internal), certainty: 'known' as const }
        : absoluteTarget(ctx, imported.module);
    });
    return dedupeTargets(targets);
  }

  const base = relativeBase(importerPath, imported, ctx.moduleNameByPath);
  if (base === null || base === '') {
    const display = `${'.'.repeat(imported.level)}${imported.module}`;
    return [{ display, target: ensureExternal(ctx, `unresolved:${display}`), certainty: 'partial' }];
  }
  const targets = imported.names.map((name) => {
    const child = `${base}.${name}`;
    const internal = ctx.moduleByName.get(child);
    if (internal) return { display: child, target: moduleNodeId(internal), certainty: 'known' as const };
    const baseInternal = ctx.moduleByName.get(base);
    return baseInternal
      ? { display: base, target: moduleNodeId(baseInternal), certainty: 'known' as const }
      : { ...externalTarget(ctx, base), certainty: 'partial' as const };
  });
  return dedupeTargets(targets.length > 0 ? targets : [absoluteTarget(ctx, base)]);
}

function dedupeTargets(targets: ImportTarget[]): ImportTarget[] {
  const byKey = new Map<string, ImportTarget>();
  for (const target of targets) byKey.set(`${target.target}|${target.certainty}`, target);
  return [...byKey.values()].sort((a, b) => `${a.target}|${a.certainty}`.localeCompare(`${b.target}|${b.certainty}`));
}

function importRelation(ctx: Context, path: string, target: ImportTarget, dynamic = false): Relation {
  const certainty = dynamic ? 'partial' : target.certainty;
  return {
    id: `rel_${shortHash(`${path}|python-import|${target.display}|${target.target}|${dynamic}`)}`,
    type: 'imports',
    target: target.target,
    certainty,
    provenance: PROVENANCE,
    evidence: [
      evidence(
        ctx.discovery,
        ctx.analyzerVersion,
        path,
        `${dynamic ? 'dynamic-' : ''}import ${target.display}`,
        target.display,
      ),
    ],
  };
}

function partialPublish(ctx: Context, path: string, kind: 'route' | 'cli', value: string): Relation {
  const title = `${kind}:${value}`;
  return {
    id: `rel_${shortHash(`${path}|python-${kind}|${value}`)}`,
    type: 'publishes',
    target: ensureExternal(ctx, title),
    certainty: 'partial',
    provenance: PROVENANCE,
    evidence: [evidence(ctx.discovery, ctx.analyzerVersion, path, `${kind} ${value}`)],
  };
}

function claimsFor(ctx: Context, path: string, analysis: PythonAnalysis): Claim[] {
  const claims: Claim[] = [];
  if (analysis.entry_signals.length > 0) {
    claims.push({
      id: `claim_${shortHash(`${path}|python-entry`)}`,
      type: 'fact',
      text: `Entry point (${analysis.entry_signals.join(', ')}).`,
      status: 'active',
      confidence: 1,
      provenance: PROVENANCE,
      evidence: [
        evidence(ctx.discovery, ctx.analyzerVersion, path, `entry-point ${analysis.entry_signals.join(',')}`),
      ],
    });
  }
  if (pytestPath(path)) {
    claims.push({
      id: `claim_${shortHash(`${path}|pytest-path`)}`,
      type: 'fact',
      text: 'Pytest test module (path convention).',
      status: 'active',
      confidence: 1,
      provenance: PROVENANCE,
      evidence: [evidence(ctx.discovery, ctx.analyzerVersion, path, 'pytest path convention')],
    });
  }
  return claims;
}

/** Analyze all retained Python files; unavailable runtime degrades honestly, invalid runtime fails closed. */
export function analyzePythonModules(
  discovery: Discovery,
  state: PythonWorkerState = probePythonWorker(),
): PythonModelResult {
  if (state.status === 'unavailable') return { capability: unsupportedCapability(), nodes: [] };
  if (state.status === 'invalid') throw new ScanInputError(state.reason);

  const analyses = new Map<string, PythonAnalysis>();
  for (const path of [...discovery.contents.keys()].filter(isPython).sort()) {
    const result = analyzeWithPythonWorker(state, path, discovery.contents.get(path)!);
    if (result) analyses.set(path, result);
  }

  const moduleCandidates = new Map<string, string[]>();
  const moduleNameByPath = new Map<string, string>();
  const analyzedPaths = new Set(analyses.keys());
  for (const path of analyses.keys()) {
    const name = moduleName(path, analyzedPaths);
    if (name) {
      moduleNameByPath.set(path, name);
      const candidates = moduleCandidates.get(name);
      if (candidates) candidates.push(path);
      else moduleCandidates.set(name, [path]);
    }
  }
  // A module name with multiple filesystem candidates is ambiguous; never choose one by
  // iteration order and accidentally promote the relation to known.
  const moduleByName = new Map(
    [...moduleCandidates].flatMap(([name, candidates]) =>
      candidates.length === 1 ? [[name, candidates[0]!] as const] : [],
    ),
  );
  const dependencies = declaredPythonDependencies(
    state,
    discovery.contents.get('pyproject.toml')?.toString('utf8') ?? '',
    discovery.contents.get('requirements.txt')?.toString('utf8') ?? '',
  );
  const ctx: Context = {
    discovery,
    moduleByName,
    moduleNameByPath,
    stdlib: state.stdlib,
    dependencies,
    analyzerVersion: state.analyzerVersion,
    externals: new Map(),
  };
  const modules: Node[] = [];

  for (const [path, analysis] of analyses) {
    const relations: Relation[] = [];
    for (const imported of analysis.imports) {
      for (const target of staticTargets(ctx, path, imported)) relations.push(importRelation(ctx, path, target));
    }
    for (const specifier of analysis.dynamic_imports) {
      relations.push(importRelation(ctx, path, absoluteTarget(ctx, specifier), true));
    }
    for (const route of analysis.routes) relations.push(partialPublish(ctx, path, 'route', route));
    for (const command of analysis.cli_commands) relations.push(partialPublish(ctx, path, 'cli', command));
    const uniqueRelations = new Map(relations.map((relation) => [relation.id, relation]));
    modules.push({
      id: moduleNodeId(path),
      slug: slugFor(path),
      kind: 'module',
      title: path,
      scope: analysis.symbols.length > 0 ? { files: [path], symbols: analysis.symbols } : { files: [path] },
      claims: claimsFor(ctx, path, analysis),
      relations: [...uniqueRelations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  return {
    capability: supportedCapability(state.analyzerVersion),
    nodes: [...modules, ...ctx.externals.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function currentPythonCapability(): Capability {
  const state = probePythonWorker();
  return state.status === 'available' ? supportedCapability(state.analyzerVersion) : unsupportedCapability();
}
