/**
 * V5's read-only viewer adapters for impact highlighting and filter metadata.
 *
 * The browser never reads the repository directly.  It asks this module for two small, typed
 * projections of the already-validated tracked model:
 *
 * - `/api/impact?path=<repo-relative-path>` is the same `impactReport` the CLI command uses;
 * - `/api/viewer-filters` carries only the stale/confidence/provenance facets that the client
 *   needs to hide cards and relations.  It deliberately contains no claim body or source text.
 *
 * Both handlers re-read the baseline for each request, stay inside the loopback router's GET-only
 * boundary, and never mutate tracked state.  The impact response neutralizes display titles before
 * they reach a browser, while retaining the CLI's node-id/reason semantics exactly.
 */

import type { ServerResponse } from 'node:http';
import { toCanonicalJson } from '../model/canonical.js';
import type { Actor, Claim, Node, Relation } from '../model/types.js';
import { loadTrackedProject } from '../query/project.js';
import { impactReport } from '../query/reports.js';
import { neutralizeText } from '../render/sanitize.js';
import { computeStatus } from '../scan/status.js';
import type { FeatureModule, RequestContext } from './router.js';

/** Schema version of V5's narrow read-only endpoint envelopes. */
export const IMPACT_VIEWER_API_SCHEMA_VERSION = 1;

type ViewerActor = Actor | 'unknown';

interface FilterClaimFacet {
  id: string;
  type: Claim['type'];
  status: Claim['status'];
  confidence: number;
  actor: Actor;
}

interface FilterRelationFacet {
  id: string;
  source: string;
  target: string;
  type: Relation['type'];
  certainty: Relation['certainty'];
  actor: ViewerActor;
}

interface FilterNodeFacet {
  id: string;
  /** Claim provenance plus outgoing-relation provenance; `unknown` is never promoted. */
  actors: ViewerActor[];
  claims: FilterClaimFacet[];
  stale: { claim: boolean; status: boolean };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(toCanonicalJson(payload));
}

/**
 * Keep the viewer endpoint intentionally narrower than arbitrary filesystem input.  This is not a
 * path resolver — `impactReport` only compares model scope strings — but rejecting absolute,
 * parent-traversing, empty, and NUL inputs makes that fact explicit at the public boundary.
 */
function requestedPaths(ctx: RequestContext): { ok: true; paths: string[] } | { ok: false; error: string } {
  const paths = ctx.url.searchParams.getAll('path');
  if (paths.length === 0) return { ok: false, error: 'impact requires at least one path' };
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.includes('\0') ||
      path.startsWith('/') ||
      path.split('/').includes('..')
    ) {
      return { ok: false, error: 'impact paths must be repository-relative and cannot escape the project' };
    }
  }
  return { ok: true, paths };
}

function handleImpact(cwd: string, res: ServerResponse, ctx: RequestContext): void {
  const input = requestedPaths(ctx);
  if (!input.ok) {
    sendJson(res, 400, { error: input.error });
    return;
  }

  const loaded = loadTrackedProject(cwd);
  if (!loaded.ok) {
    sendJson(res, 409, { error: loaded.error });
    return;
  }

  // This is deliberately the same report builder as `archmap impact --json`.  Browser-only
  // neutralization is limited to labels; IDs, membership, ordering, and reasons are unchanged.
  const report = impactReport(loaded.baseline.nodes, input.paths);
  sendJson(res, 200, {
    schema_version: IMPACT_VIEWER_API_SCHEMA_VERSION,
    command: 'impact',
    ...report,
    impacted: report.impacted.map((entry) => ({ ...entry, title: neutralizeText(entry.title) })),
  });
}

function actorOf(relation: Relation): ViewerActor {
  return relation.provenance?.actor ?? 'unknown';
}

function nodeFacet(node: Node, staleStatus: ReadonlySet<string>): FilterNodeFacet {
  const claims = node.claims.map((claim) => ({
    id: claim.id,
    type: claim.type,
    status: claim.status,
    confidence: claim.confidence,
    actor: claim.provenance.actor,
  }));
  const actors = new Set<ViewerActor>([
    ...claims.map((claim) => claim.actor),
    ...node.relations.map(actorOf),
  ]);
  return {
    id: node.id,
    actors: [...actors].sort(),
    claims,
    stale: {
      claim: claims.some((claim) => claim.status === 'stale'),
      status: staleStatus.has(node.id),
    },
  };
}

function relationFacets(nodes: Node[]): FilterRelationFacet[] {
  return nodes
    .flatMap((node) =>
      node.relations.map((relation) => ({
        id: relation.id,
        source: node.id,
        target: relation.target,
        type: relation.type,
        certainty: relation.certainty,
        actor: actorOf(relation),
      })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function handleFilterMetadata(cwd: string, res: ServerResponse): void {
  const loaded = loadTrackedProject(cwd);
  if (!loaded.ok) {
    sendJson(res, 409, { error: loaded.error });
    return;
  }

  // `computeStatus` is the exact read-only status query used by the CLI.  Its stale-node set is
  // surfaced separately from authored claim status so the client never conflates the two.
  const status = computeStatus(loaded.root);
  const staleStatus = new Set(status.stale_nodes);
  sendJson(res, 200, {
    schema_version: IMPACT_VIEWER_API_SCHEMA_VERSION,
    command: 'viewer-filters',
    status: { clean: status.clean, stale_nodes: status.stale_nodes },
    nodes: loaded.baseline.nodes.map((node) => nodeFacet(node, staleStatus)).sort((a, b) => a.id.localeCompare(b.id)),
    relations: relationFacets(loaded.baseline.nodes),
  });
}

/** Fixed V5 feature module: two exact, local, read-only routes and no fallback. */
export function createImpactFeature(cwd: string): FeatureModule {
  return {
    name: 'impact-api',
    routes: [
      { path: '/api/impact', handler: (_req, res, ctx) => handleImpact(cwd, res, ctx) },
      { path: '/api/viewer-filters', handler: (_req, res) => handleFilterMetadata(cwd, res) },
    ],
  };
}
