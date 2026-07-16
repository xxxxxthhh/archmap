/**
 * Content-safety policy for the loopback viewer (Issue #30, Tier C).
 *
 * Every response the router emits — asset, API, error — carries these headers. The policy is the
 * enforced half of the viewer's safety contract; the projection layer (`neutralizeText`) is the
 * data half. Together they guarantee that hostile repository content served as data can never
 * execute, and that the page can never reach a remote origin.
 *
 * The CSP is deliberately maximal:
 *   - `default-src 'none'` denies every fetch destination unless re-granted below, so a stray
 *     `<img>`, font, XHR, or frame to any origin is blocked.
 *   - `script-src 'self'` allows only same-origin bundled scripts. No `'unsafe-inline'` (so inline
 *     `<script>` and `onerror=`/`onclick=` handlers never run) and no `'unsafe-eval'` (so
 *     `eval`/`new Function` are dead). This is why the viewer ships `app.js` as a separate file.
 *   - `style-src 'self'` likewise forbids inline style injection.
 *   - `img-src 'self' data:` permits only same-origin and inline data images — never a remote pixel.
 *   - `connect-src 'self'` confines fetch/XHR/WebSocket to the loopback origin.
 *   - `base-uri`/`form-action`/`frame-ancestors 'none'` close off `<base>` hijack, form exfil, and
 *     clickjacking.
 * No `Access-Control-Allow-*` header is ever set, so the origin grants no cross-origin read.
 */

import type { ServerResponse } from 'node:http';

/** The single Content-Security-Policy string sent with every viewer response. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Apply the viewer's content-safety headers to `res`. Called by the router for every response. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Same-origin only: the viewer never participates in a cross-origin embed or read.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
