/**
 * Read-only commit-to-commit architecture diff for the loopback viewer.
 *
 * This adapter deliberately returns the existing diff engine's report unchanged, with one
 * browser-facing state bit for the identity case. It does not reconstruct or summarize the
 * node/relation streams, so the viewer sees the same added, removed, and changed facts as the
 * CLI. Ref resolution and historical model reads remain owned by `architectureDiff`.
 */

import type { ServerResponse } from 'node:http';
import { architectureDiff } from '../diff/diff.js';
import type { ArchDiffReport } from '../diff/types.js';
import { toCanonicalJson } from '../model/canonical.js';
import type { Scope } from '../model/types.js';
import { neutralizeText } from '../render/sanitize.js';
import { StoreError } from '../store-errors.js';
import type { FeatureModule, RequestContext } from './router.js';

/** Keep request parsing bounded before handing a ref to the Git-backed diff engine. */
const MAX_REF_CHARS = 256;

interface DiffRefs {
  base: string;
  head: string;
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(toCanonicalJson(payload));
}

/**
 * Git's resolver still provides the authoritative revision validation. This boundary only
 * rejects inputs that are invalid as request values or could be mistaken for command options.
 */
function safeRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REF_CHARS &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !hasControl(value)
  );
}

/** Require exactly one bounded base and head ref; there is no implicit current-HEAD fallback. */
function requestedRefs(ctx: RequestContext): DiffRefs | undefined {
  const bases = ctx.url.searchParams.getAll('base');
  const heads = ctx.url.searchParams.getAll('head');
  if (bases.length !== 1 || heads.length !== 1) return undefined;

  const base = bases[0]!;
  const head = heads[0]!;
  return safeRef(base) && safeRef(head) ? { base, head } : undefined;
}

/**
 * The V2 engine owns diff membership, ordering, ids, types, certainty, and lifecycle status.
 * At the Viewer boundary, mirror the existing graph/impact projection rule: free-form titles,
 * scope values, and claim bodies must be made inert before they are emitted as browser JSON.
 * This deliberately does not reinterpret the report or alter its semantic buckets.
 */
function viewerDiffReport(report: ArchDiffReport): ArchDiffReport {
  const scope = (value: Scope): Scope => ({
    ...(value.files ? { files: value.files.map((file) => neutralizeText(file)) } : {}),
    ...(value.symbols ? { symbols: value.symbols.map((symbol) => neutralizeText(symbol)) } : {}),
  });
  const node = (entry: ArchDiffReport['nodes']['added'][number]) => ({
    ...entry,
    title: neutralizeText(entry.title),
    ...(entry.scope ? { scope: scope(entry.scope) } : {}),
  });
  const claim = (entry: ArchDiffReport['claims']['added'][number]) => ({
    ...entry,
    text: neutralizeText(entry.text),
  });

  return {
    ...report,
    nodes: {
      added: report.nodes.added.map(node),
      removed: report.nodes.removed.map(node),
      changed: report.nodes.changed.map((entry) => ({ before: node(entry.before), after: node(entry.after) })),
    },
    claims: {
      added: report.claims.added.map(claim),
      removed: report.claims.removed.map(claim),
      changed: report.claims.changed.map((entry) => ({ before: claim(entry.before), after: claim(entry.after) })),
      stale: report.claims.stale.map(claim),
    },
  };
}

function handleDiff(cwd: string, res: ServerResponse, ctx: RequestContext): void {
  const refs = requestedRefs(ctx);
  if (!refs) {
    sendJson(res, 400, { error: 'diff requires exactly one safe base ref and head ref' });
    return;
  }

  try {
    const report = viewerDiffReport(architectureDiff(cwd, refs.base, refs.head));
    sendJson(res, 200, { ...report, identical: report.base === report.head });
  } catch (error) {
    // Ref/model failures are expected invalid requests, not internal server faults. Keep any
    // user-controlled ref text inert before returning it in the JSON error envelope.
    if (error instanceof StoreError) {
      sendJson(res, 400, { error: neutralizeText(error.message) });
      return;
    }
    throw error;
  }
}

/** Fixed viewer feature: one exact GET route, registered through the dedicated diff slot. */
export function createDiffFeature(cwd: string): FeatureModule {
  return {
    name: 'viewer-diff-api',
    routes: [{ path: '/api/diff', handler: (_req, res, ctx) => handleDiff(cwd, res, ctx) }],
  };
}
