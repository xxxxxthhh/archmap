/**
 * Build architecture nodes from TypeScript/JavaScript analysis.
 *
 * Produces one `module` node per analyzed file (scoping the file + its exported symbols) and
 * one `external` node per imported target. Import resolution is deliberately conservative so
 * a `known` relation is only ever a verifiable fact:
 *   - relative imports resolving to a repo file → `known` internal;
 *   - `tsconfig` path aliases resolving to a repo file → `known` internal;
 *   - Node builtins and declared package.json dependencies → `known` external;
 *   - anything else (an unconfigured alias, an undeclared bare specifier) → `partial`, since
 *     without full module resolution it cannot be asserted to be external.
 * Heuristic detections (routes, HTTP calls, CLI commands) are `partial` too. Every relation
 * and fact carries re-verifiable evidence. Evidence identity is the working tree when the
 * scan ran against a dirty tree (the snapshot still records base_commit separately), so a
 * working-tree blob is never mislabeled as a HEAD blob.
 *
 * All output is deterministic: analyzer facts use a fixed sentinel `created_at` and every
 * list is sorted.
 */

import { builtinModules } from 'node:module';
import _ts from 'typescript';
import { TYPESCRIPT_ADAPTER_VERSION } from '../capabilities.js';
import { hashContent } from '../scan/hash.js';
import { nodeId, slugFor } from '../scan/nodes.js';
import type { Discovery } from '../scan/types.js';
import type { Claim, Evidence, Node, Provenance, Relation } from '../model/types.js';
import { isTsJs } from './languages.js';
import { analyzeSource } from './typescript.js';

const ts = _ts as unknown as typeof import('typescript');

const ANALYZER = 'typescript';
const ANALYZER_PROVENANCE: Provenance = { actor: 'analyzer', created_at: '1970-01-01T00:00:00Z' };
const BUILTINS = new Set(builtinModules);

const shortHash = (key: string): string => hashContent(Buffer.from(key)).replace('sha256:', '').slice(0, 16);
const moduleNodeId = (path: string): string => nodeId(`module:${path}`);
const externalNodeId = (name: string): string => nodeId(`external:${name}`);

/** Resolve a relative specifier to an analyzable repo file (honoring NodeNext `.js`→`.ts`). */
function resolveInternal(base: string, fileSet: Set<string>): string | null {
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const candidates: string[] = [base];
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    for (const e of exts) candidates.push(stem + e);
  } else {
    for (const e of exts) candidates.push(base + e);
    for (const e of exts) candidates.push(`${base}/index${e}`);
  }
  for (const c of candidates) if (fileSet.has(c) && isTsJs(c)) return c;
  return null;
}

/**
 * Normalize a POSIX path relative to the repository root, returning null when it does not
 * denote an in-repo, repo-relative location — either because it is absolute (a
 * filesystem-absolute path, e.g. from `baseUrl: "/"`, is not a repo-relative module) or
 * because a `..` segment escapes above the root. Such targets must NOT be clamped back into
 * the repo — an out-of-repo target cannot be asserted as an internal `known` module.
 */
function normalizeWithinRoot(path: string): string | null {
  if (path.startsWith('/')) return null; // absolute path — outside the repo-relative model
  const segs: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (segs.length === 0) return null; // root underflow → escapes the repository
      segs.pop();
    } else {
      segs.push(seg);
    }
  }
  return segs.join('/');
}

function resolveRelativeBase(importerPath: string, specifier: string): string | null {
  const dir = importerPath.includes('/') ? importerPath.slice(0, importerPath.lastIndexOf('/')) : '';
  return normalizeWithinRoot(`${dir}/${specifier}`);
}

/** Bare-specifier package name (`@scope/pkg`, `node:fs`, or the first path segment). */
function packageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  if (specifier.startsWith('node:')) return specifier.split('/')[0]!;
  return specifier.split('/')[0]!;
}

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier.split('/')[0]!);
}

interface AliasConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/** Parse `compilerOptions.paths`/`baseUrl` from a tsconfig, or null if absent/invalid. */
function parseAliasConfig(content: string): AliasConfig | null {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', content);
  if (parsed.error) return null;
  const co = (parsed.config as { compilerOptions?: { paths?: unknown; baseUrl?: unknown } } | undefined)
    ?.compilerOptions;
  if (!co || typeof co.paths !== 'object' || co.paths === null) return null;
  const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
  return { baseUrl, paths: co.paths as Record<string, string[]> };
}

/**
 * Resolve a bare specifier through tsconfig path aliases to a repo file, or null. Follows
 * TypeScript precedence: matching patterns are tried most-specific first (an exact pattern,
 * then the longest matching prefix), so an overlapping specific alias wins over a generic one.
 */
function resolveAlias(specifier: string, config: AliasConfig, fileSet: Set<string>): string | null {
  const matches: Array<{ specificity: number; matched: string; targets: string[] }> = [];
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === specifier) matches.push({ specificity: Infinity, matched: '', targets: asArray(targets) });
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        matches.push({
          specificity: prefix.length, // TS: longest matching prefix wins
          matched: specifier.slice(prefix.length, specifier.length - suffix.length),
          targets: asArray(targets),
        });
      }
    }
  }
  matches.sort((a, b) => b.specificity - a.specificity);
  for (const match of matches) {
    for (const target of match.targets) {
      const sub = target.includes('*') ? target.replace('*', match.matched) : target;
      // An absolute target overrides baseUrl; an absolute baseUrl makes the join absolute.
      // Either way `normalizeWithinRoot` rejects it, so an out-of-repo alias stays unresolved.
      const joined = sub.startsWith('/') ? sub : `${config.baseUrl}/${sub}`;
      const base = normalizeWithinRoot(joined);
      if (base !== null) {
        const hit = resolveInternal(base, fileSet);
        if (hit) return hit;
      }
    }
  }
  return null;
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Package names declared in a package.json's dependency fields. */
function parseDeclaredDeps(content: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const obj = pkg[field];
      if (obj && typeof obj === 'object') for (const name of Object.keys(obj)) deps.add(name);
    }
  } catch {
    // A malformed package.json just yields no declared deps (imports stay partial).
  }
  return deps;
}

interface Ctx {
  fileSet: Set<string>;
  blobHashByPath: Map<string, string>;
  commit: string;
  aliases: AliasConfig | null;
  deps: Set<string>;
  externals: Map<string, Node>;
}

function evidence(ctx: Ctx, path: string, blobHash: string, extract: string, symbol?: string): Evidence {
  return {
    repository: 'local',
    commit: ctx.commit,
    path,
    ...(symbol ? { symbol } : {}),
    analyzer: ANALYZER,
    analyzer_version: TYPESCRIPT_ADAPTER_VERSION,
    blob_hash: blobHash,
    extract_hash: hashContent(Buffer.from(extract)),
  };
}

function ensureExternal(ctx: Ctx, name: string): string {
  const id = externalNodeId(name);
  if (!ctx.externals.has(id)) {
    ctx.externals.set(id, { id, slug: slugFor(name), kind: 'external', title: name, claims: [], relations: [] });
  }
  return id;
}

function importRelation(ctx: Ctx, importerPath: string, blobHash: string, specifier: string): Relation {
  const id = `rel_${shortHash(`${importerPath}|import|${specifier}`)}`;
  const ev = evidence(ctx, importerPath, blobHash, `import ${specifier}`, specifier);
  const base = { id, type: 'imports' as const, provenance: ANALYZER_PROVENANCE, evidence: [ev] };
  const known = (target: string): Relation => ({ ...base, target, certainty: 'known' });
  const partial = (name: string): Relation => ({ ...base, target: ensureExternal(ctx, name), certainty: 'partial' });

  if (specifier.startsWith('.')) {
    const relBase = resolveRelativeBase(importerPath, specifier);
    const internal = relBase !== null ? resolveInternal(relBase, ctx.fileSet) : null;
    // A relative import that escapes the repo root (relBase === null) is unresolvable → partial.
    return internal ? known(moduleNodeId(internal)) : partial(`unresolved:${specifier}`);
  }
  // Bare specifier: only assert `known external`/`known internal` when it is actually verifiable.
  const aliased = ctx.aliases && resolveAlias(specifier, ctx.aliases, ctx.fileSet);
  if (aliased) return known(moduleNodeId(aliased));
  if (isBuiltin(specifier) || ctx.deps.has(packageName(specifier))) {
    return known(ensureExternal(ctx, packageName(specifier)));
  }
  return partial(packageName(specifier));
}

/** Build module + external nodes from a discovery's analyzable file contents. */
export function analyzeModules(discovery: Discovery): Node[] {
  const fileSet = new Set(discovery.files.map((f) => f.path));
  const blobHashByPath = new Map(discovery.files.map((f) => [f.path, f.blob_hash]));
  const tsconfig = discovery.contents.get('tsconfig.json');
  const pkg = discovery.contents.get('package.json');
  const ctx: Ctx = {
    fileSet,
    blobHashByPath,
    // Dirty tree → identity is the working tree, not HEAD (snapshot still keeps base_commit).
    commit: discovery.dirty ? 'working-tree' : (discovery.base_commit ?? 'working-tree'),
    aliases: tsconfig ? parseAliasConfig(tsconfig.toString('utf8')) : null,
    deps: pkg ? parseDeclaredDeps(pkg.toString('utf8')) : new Set(),
    externals: new Map(),
  };

  const moduleNodes: Node[] = [];
  for (const path of [...discovery.contents.keys()].filter(isTsJs).sort()) {
    const blobHash = blobHashByPath.get(path);
    if (blobHash === undefined) continue;
    const analysis = analyzeSource(path, discovery.contents.get(path)!.toString('utf8'));

    const relations: Relation[] = analysis.imports.map((spec) => importRelation(ctx, path, blobHash, spec));
    for (const route of analysis.routes) {
      relations.push({
        id: `rel_${shortHash(`${path}|route|${route.method} ${route.path}`)}`,
        type: 'publishes',
        target: ensureExternal(ctx, `route:${route.method} ${route.path}`),
        certainty: 'partial',
        provenance: ANALYZER_PROVENANCE,
        evidence: [evidence(ctx, path, blobHash, `route ${route.method} ${route.path}`)],
      });
    }
    for (const marker of analysis.httpCalls) {
      relations.push({
        id: `rel_${shortHash(`${path}|http|${marker}`)}`,
        type: 'calls',
        target: ensureExternal(ctx, `http:${marker}`),
        certainty: 'partial',
        provenance: ANALYZER_PROVENANCE,
        evidence: [evidence(ctx, path, blobHash, `http-call ${marker}`)],
      });
    }
    for (const name of analysis.cliCommands) {
      relations.push({
        id: `rel_${shortHash(`${path}|cli|${name}`)}`,
        type: 'publishes',
        target: ensureExternal(ctx, `cli:${name}`),
        certainty: 'partial',
        provenance: ANALYZER_PROVENANCE,
        evidence: [evidence(ctx, path, blobHash, `cli-command ${name}`)],
      });
    }

    const claims: Claim[] = [];
    if (analysis.entrySignals.length > 0) {
      claims.push({
        id: `claim_${shortHash(`${path}|entry`)}`,
        type: 'fact',
        text: `Entry point (${analysis.entrySignals.join(', ')}).`,
        status: 'active',
        confidence: 1,
        provenance: ANALYZER_PROVENANCE,
        evidence: [evidence(ctx, path, blobHash, `entry-point ${analysis.entrySignals.join(',')}`)],
      });
    }

    moduleNodes.push({
      id: moduleNodeId(path),
      slug: slugFor(path),
      kind: 'module',
      title: path,
      scope: analysis.exports.length > 0 ? { files: [path], symbols: analysis.exports } : { files: [path] },
      claims,
      relations: relations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  }

  const externalNodes = [...ctx.externals.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return [...moduleNodes, ...externalNodes];
}
