/**
 * Read-only JSON query feature for the loopback viewer (Issue #30).
 *
 * `GET /api/graph[?view=<id>]` returns the deterministic display-graph projection the browser map
 * renders. It is strictly read-only and reuses the exact same query path as `archmap export`:
 * every field is re-read and re-validated per request (never answered from a process-stale model),
 * untrusted free text was already neutralized by the projection, and the readability probe gates
 * oversized graphs. There is no write, filesystem-browse, or arbitrary-fetch surface here — only a
 * projection of already-tracked state.
 *
 * All failures are fail-closed JSON with a stable `error` field and a matching status; nothing
 * partial is emitted.
 */

import type { ServerResponse } from 'node:http';
import { toCanonicalJson } from '../model/canonical.js';
import { loadTrackedProject } from '../query/project.js';
import { projectModel, readabilityProbe } from '../render/index.js';
import { defaultView, loadView } from '../views/load.js';
import type { FeatureModule, RequestContext } from './router.js';

/** Schema version of the `/api/graph` envelope. Bump when the shape changes. */
export const GRAPH_API_SCHEMA_VERSION = 1;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(toCanonicalJson(payload));
}

function handleGraph(cwd: string, res: ServerResponse, ctx: RequestContext): void {
  const viewId = ctx.url.searchParams.get('view');

  const loaded = loadTrackedProject(cwd);
  if (!loaded.ok) {
    // Not an archmap project / not scanned: the viewer has nothing to show, fail closed.
    sendJson(res, 409, { error: loaded.error });
    return;
  }

  const viewResult = viewId === null ? defaultView() : loadView(loaded.root, viewId);
  if (!viewResult.ok) {
    sendJson(res, 400, { error: `view: ${viewResult.error}` });
    return;
  }

  const graph = projectModel(loaded.baseline.nodes, viewResult.view);
  const probe = readabilityProbe(graph);
  if (!probe.ok) {
    sendJson(res, 422, { error: `readability probe failed: ${probe.reason}` });
    return;
  }

  sendJson(res, 200, {
    schema_version: GRAPH_API_SCHEMA_VERSION,
    view: graph.view,
    projection: { nodes: graph.nodes, edges: graph.edges, stats: graph.stats },
  });
}

/** The graph-query feature: registers the read-only `/api/graph` endpoint bound to `cwd`. */
export function createGraphFeature(cwd: string): FeatureModule {
  return {
    name: 'graph-api',
    routes: [{ path: '/api/graph', handler: (_req, res, ctx) => handleGraph(cwd, res, ctx) }],
  };
}
