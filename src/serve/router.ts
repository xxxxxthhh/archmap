/**
 * The single sanctioned router seam for the loopback viewer (Issue #30).
 *
 * This is the one place requests enter the viewer, and the one place the read-only and
 * content-safety contracts are enforced for *every* feature:
 *   - only `GET` is accepted; any mutating method is refused with `405` before a handler runs, so
 *     no feature can accidentally expose a write;
 *   - security headers (CSP et al.) are applied to every response, including errors;
 *   - a request is dispatched to at most one feature-registered handler.
 *
 * Features register through {@link FeatureModule}. A feature contributes exact-path `routes` and/or
 * a single `fallback` (the static-asset catch-all owns the fallback today). Because registration is
 * a plain list of self-contained modules with disjoint paths, later milestones (V4/V5) can be
 * frozen with truly disjoint write leases: each adds its own module without editing this file or an
 * existing feature. Duplicate paths or a second fallback are rejected at construction, so an
 * overlapping mount fails loudly instead of silently shadowing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders } from './content-safety.js';

/** Per-request context handed to every handler. `url` is parsed against the loopback origin. */
export interface RequestContext {
  url: URL;
}

/** A request handler. It must only read; the router guarantees the method is `GET`. */
export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => void | Promise<void>;

/** The composed request listener the router returns — the single entry point for a request. */
export type ViewerRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** An exact-pathname GET route. */
export interface Route {
  path: string;
  handler: Handler;
}

/**
 * A mountable viewer feature. `routes` are matched by exact pathname; `fallback` handles any
 * request no route matched. At most one feature across the whole router may provide a `fallback`.
 */
export interface FeatureModule {
  name: string;
  routes?: Route[];
  fallback?: Handler;
}

function endText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

/**
 * Build the viewer request handler from a list of feature modules. Throws on an overlapping mount
 * (duplicate route path, or a second fallback owner) so misconfiguration is caught at startup.
 */
export function createRouter(features: FeatureModule[]): ViewerRequestHandler {
  const routes = new Map<string, Handler>();
  let fallback: Handler | undefined;
  let fallbackOwner: string | undefined;

  for (const feature of features) {
    for (const route of feature.routes ?? []) {
      if (routes.has(route.path)) {
        throw new Error(`duplicate viewer route "${route.path}" registered by feature "${feature.name}"`);
      }
      routes.set(route.path, route.handler);
    }
    if (feature.fallback) {
      if (fallback) {
        throw new Error(
          `viewer feature "${feature.name}" registers a fallback, but "${fallbackOwner}" already owns it`,
        );
      }
      fallback = feature.fallback;
      fallbackOwner = feature.name;
    }
  }

  return async function handle(req, res): Promise<void> {
    applySecurityHeaders(res);

    // Read-only boundary: refuse every mutating (or otherwise non-GET) method before dispatch.
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      endText(res, 405, 'method not allowed');
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      endText(res, 400, 'bad request');
      return;
    }

    const handler = routes.get(url.pathname) ?? fallback;
    if (!handler) {
      endText(res, 404, 'not found');
      return;
    }

    await handler(req, res, { url });
  };
}
