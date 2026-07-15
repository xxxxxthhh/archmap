/**
 * Static viewer assets feature (Issue #30).
 *
 * Serves the locally bundled, version-pinned viewer shell from `viewer/` — never from the analyzed
 * repository, and never a file outside the viewer directory. Assets are resolved with the same
 * boundary discipline the store uses:
 *   - only an allowlisted extension (`.html`, `.js`, `.css`) is servable, so no arbitrary file type
 *     can be exfiltrated even from inside `viewer/`;
 *   - the decoded request path is rejected if it contains a NUL or resolves outside the viewer root
 *     (`..`, absolute, or encoded-traversal attempts all fail closed);
 *   - the file is `lstat`-checked and opened `O_NOFOLLOW`, so a planted symlink is refused rather
 *     than followed out of the tree.
 *
 * The viewer directory is resolved relative to this module, so it is the same in `tsx` (repo
 * `viewer/`) and in the built package (`dist/serve/assets.js` -> package `viewer/`).
 */

import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureModule, RequestContext } from './router.js';

/** Absolute path to the bundled viewer assets, resolved once from this module's location. */
const VIEWER_ROOT = resolve(fileURLToPath(new URL('../../viewer/', import.meta.url)));

/** The only extensions the viewer serves, each mapped to its content type. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Resolve a request pathname to a safe absolute asset path, or `null` if it must be refused. */
function resolveAssetPath(pathname: string): { path: string; contentType: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const ext = extname(rel);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return null;

  const full = resolve(VIEWER_ROOT, rel);
  // Containment check: the resolved path must be the root itself or strictly inside it.
  if (full !== VIEWER_ROOT && !full.startsWith(VIEWER_ROOT + sep)) return null;
  return { path: full, contentType };
}

/** Read an asset file, refusing symlinks and non-regular files. */
function readAsset(path: string): Buffer | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask a successful read; the descriptor is abandoned.
    }
  }
}

function serveAsset(res: ServerResponse, ctx: RequestContext): void {
  const resolved = resolveAssetPath(ctx.url.pathname);
  if (!resolved) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
    return;
  }
  const body = readAsset(resolved.path);
  if (!body) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', resolved.contentType);
  res.end(body);
}

/** The viewer-shell feature: owns the router fallback and serves bundled static assets. */
export function createAssetsFeature(): FeatureModule {
  return {
    name: 'viewer-assets',
    fallback: (_req, res, ctx) => serveAsset(res, ctx),
  };
}
