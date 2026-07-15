/**
 * Bounded read-only evidence inspection for the loopback viewer (Issue #31).
 *
 * This endpoint deliberately accepts only one already-tracked node, claim, or relation id. It
 * reuses the same `evidenceFor` query as `archmap evidence`, then adds only presentation metadata
 * and a fixed-size, text-only source excerpt. It is not a file browser: a caller cannot supply a
 * path, and an excerpt is read only when the selected tracked evidence pointer resolves to a
 * regular file inside the scanned project root.
 */

import { closeSync, constants, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { toCanonicalJson } from '../model/canonical.js';
import type { Actor, Claim, Evidence, Node, Provenance, Relation } from '../model/types.js';
import { evidenceFor, type EvidenceResult } from '../query/queries.js';
import { loadTrackedProject } from '../query/project.js';
import { neutralizeText } from '../render/sanitize.js';
import type { ViewerExtensionContext, ViewerExtensionRegistry } from './features.js';
import type { FeatureModule, RequestContext } from './router.js';

/** Schema version for the bounded `/api/evidence` inspection payload. */
export const EVIDENCE_API_SCHEMA_VERSION = 1;

/** Never read or return a whole source file through the viewer. */
const MAX_EXCERPT_BYTES = 2_048;
const MAX_EXCERPT_CHARS = 500;
const MAX_TARGET_CHARS = 512;

type EvidenceMatch = NonNullable<EvidenceResult['matched']>;
type ViewerActor = Actor | 'unknown';

interface ViewerProvenance {
  actor: ViewerActor;
  created_at?: string;
}

interface ViewerClaim {
  id: string;
  type: Claim['type'];
  status: Claim['status'];
  confidence: number;
  provenance: ViewerProvenance;
  text: string;
}

interface ViewerRelation {
  id: string;
  type: Relation['type'];
  target: string;
  certainty: Relation['certainty'];
  provenance: ViewerProvenance;
}

interface ViewerEvidenceExcerpt {
  index: number;
  status: 'available' | 'unavailable';
  text?: string;
  truncated?: true;
}

interface EvidenceSubject {
  node: Node;
  claims: Claim[];
  relations: Relation[];
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(toCanonicalJson(payload));
}

/** Return a model selection that exactly matches the `evidenceFor` target, never a nearby node. */
function subjectFor(nodes: Node[], target: string, matched: EvidenceMatch): EvidenceSubject | undefined {
  if (matched === 'node') {
    const node = nodes.find((entry) => entry.id === target);
    return node ? { node, claims: node.claims, relations: node.relations } : undefined;
  }

  for (const node of nodes) {
    if (matched === 'claim') {
      const claim = node.claims.find((entry) => entry.id === target);
      if (claim) return { node, claims: [claim], relations: [] };
    } else {
      const relation = node.relations.find((entry) => entry.id === target);
      if (relation) return { node, claims: [], relations: [relation] };
    }
  }
  return undefined;
}

function projectProvenance(value: Provenance | undefined): ViewerProvenance {
  if (!value) return { actor: 'unknown' };
  return {
    actor: value.actor,
    ...(value.created_at ? { created_at: neutralizeText(value.created_at) } : {}),
  };
}

function projectClaim(claim: Claim): ViewerClaim {
  return {
    id: claim.id,
    type: claim.type,
    status: claim.status,
    confidence: claim.confidence,
    provenance: projectProvenance(claim.provenance),
    text: neutralizeText(claim.text),
  };
}

function projectRelation(relation: Relation): ViewerRelation {
  return {
    id: relation.id,
    type: relation.type,
    target: relation.target,
    certainty: relation.certainty,
    provenance: projectProvenance(relation.provenance),
  };
}

/** Render the same evidence identity as the CLI, with only browser-safe text neutralization. */
function projectEvidence(evidence: Evidence): Evidence {
  return {
    repository: neutralizeText(evidence.repository),
    commit: neutralizeText(evidence.commit),
    path: neutralizeText(evidence.path),
    ...(evidence.symbol ? { symbol: neutralizeText(evidence.symbol) } : {}),
    analyzer: neutralizeText(evidence.analyzer),
    analyzer_version: neutralizeText(evidence.analyzer_version),
    blob_hash: neutralizeText(evidence.blob_hash),
    extract_hash: neutralizeText(evidence.extract_hash),
  };
}

function isInside(root: string, path: string): boolean {
  const segment = relative(root, path);
  return segment !== '' && segment !== '..' && !segment.startsWith(`..${sep}`) && !isAbsolute(segment);
}

function unavailableExcerpt(index: number): ViewerEvidenceExcerpt {
  return { index, status: 'unavailable' };
}

/**
 * Read a small source prefix only after resolving the tracked evidence pointer inside `root`.
 * Every filesystem failure, symlink, binary value, or containment failure becomes an inert
 * unavailable marker; the endpoint never exposes an arbitrary read error or a fallback file.
 */
function readExcerpt(root: string, evidence: Evidence, index: number): ViewerEvidenceExcerpt {
  if (evidence.path.includes('\0') || isAbsolute(evidence.path)) return unavailableExcerpt(index);

  let source: string;
  try {
    const rootReal = realpathSync(root);
    const candidate = resolve(rootReal, evidence.path);
    if (!isInside(rootReal, candidate)) return unavailableExcerpt(index);
    source = realpathSync(candidate);
    if (!isInside(rootReal, source)) return unavailableExcerpt(index);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return unavailableExcerpt(index);
  } catch {
    return unavailableExcerpt(index);
  }

  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unavailableExcerpt(index);
  }

  try {
    const buffer = Buffer.alloc(MAX_EXCERPT_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_EXCERPT_BYTES));
    if (bytes.includes(0)) return unavailableExcerpt(index);
    return {
      index,
      status: 'available',
      text: neutralizeText(bytes.toString('utf8'), MAX_EXCERPT_CHARS),
      ...(bytesRead > MAX_EXCERPT_BYTES ? { truncated: true as const } : {}),
    };
  } catch {
    return unavailableExcerpt(index);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing a descriptor must not turn a completed, bounded read into a server failure.
    }
  }
}

function handleEvidence(cwd: string, res: ServerResponse, ctx: RequestContext): void {
  const targets = ctx.url.searchParams.getAll('target');
  const target = targets[0];
  if (targets.length !== 1 || !target || target.length > MAX_TARGET_CHARS) {
    sendJson(res, 400, { error: 'evidence target is required exactly once' });
    return;
  }

  const loaded = loadTrackedProject(cwd);
  if (!loaded.ok) {
    sendJson(res, 409, { error: loaded.error });
    return;
  }

  // This is the exact query path used by `archmap evidence`; no node/claim fallback is allowed.
  const result = evidenceFor(loaded.baseline.nodes, target);
  if (!result.found || !result.matched) {
    sendJson(res, 404, { error: 'evidence target was not found' });
    return;
  }
  const subject = subjectFor(loaded.baseline.nodes, target, result.matched);
  if (!subject) {
    // A validated model and `evidenceFor` should make this unreachable; fail closed if not.
    sendJson(res, 409, { error: 'evidence target could not be resolved' });
    return;
  }

  sendJson(res, 200, {
    schema_version: EVIDENCE_API_SCHEMA_VERSION,
    target: result.target,
    found: true,
    matched: result.matched,
    node: {
      id: subject.node.id,
      kind: subject.node.kind,
      title: neutralizeText(subject.node.title),
    },
    claims: subject.claims.map(projectClaim),
    relations: subject.relations.map(projectRelation),
    evidence: result.evidence.map(projectEvidence),
    excerpts: result.evidence.map((entry, index) => readExcerpt(loaded.root, entry, index)),
  });
}

/** Create V4's independently owned, read-only evidence route feature. */
export function createEvidenceFeature(cwd: string): FeatureModule {
  return {
    name: 'viewer-evidence-api',
    routes: [{ path: '/api/evidence', handler: (_req, res, ctx) => handleEvidence(cwd, res, ctx) }],
  };
}

/** Register the V4 route through the finite V3 evidence slot. */
export function registerEvidenceApi(
  registry: ViewerExtensionRegistry,
  context: ViewerExtensionContext,
): void {
  registry.register('evidence', createEvidenceFeature(context.cwd));
}
