/**
 * The loopback viewer HTTP server (Issue #30, Tier C).
 *
 * Built on Node's built-in `http` only — no framework, no third-party server dependency. The
 * server binds `127.0.0.1` and refuses any non-loopback host, so the viewer is never reachable off
 * the local machine. `--port 0` is honored for tests: the ephemeral port is read back from the
 * bound socket and returned, so callers always learn the *actual* address deterministically.
 *
 * The server is assembled from mountable features through the single router seam: the read-only
 * graph API plus the static viewer shell. Adding a future feature is a new module in the list, not
 * an edit here.
 */

import { createServer, type Server } from 'node:http';
import { createGraphFeature } from './api.js';
import { createAssetsFeature } from './assets.js';
import { createRouter } from './router.js';

/** Hosts the viewer is permitted to bind. Loopback literals only — never a wildcard/any address. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

export interface ServeOptions {
  /** Project directory the read-only API queries. */
  cwd: string;
  /** Loopback host to bind. Defaults to `127.0.0.1`; a non-loopback host is refused. */
  host?: string;
  /** TCP port. `0` binds an ephemeral port (read back after listening). */
  port: number;
}

export interface RunningViewer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Start the loopback viewer. Resolves once the socket is listening, with the actual bound host and
 * port. Rejects if the host is not a loopback literal or the socket fails to bind.
 */
export function startViewerServer(opts: ServeOptions): Promise<RunningViewer> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    return Promise.reject(
      new Error(`refusing to bind non-loopback host "${host}"; the viewer binds 127.0.0.1 only`),
    );
  }

  const router = createRouter([createGraphFeature(opts.cwd), createAssetsFeature()]);
  const server = createServer((req, res) => {
    // A handler rejection must never crash the process or leak a stack to the client.
    void Promise.resolve(router(req, res)).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      if (!res.writableEnded) res.end('internal error');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // `exclusive` so two viewers never share a port; bind only the requested loopback host.
    server.listen({ host, port: opts.port, exclusive: true }, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('viewer failed to bind a TCP socket'));
        return;
      }
      // Bracket an IPv6 host for a valid URL authority (`::1` -> `[::1]`).
      const authority = address.address.includes(':') ? `[${address.address}]` : address.address;
      resolve({
        server,
        host: address.address,
        port: address.port,
        url: `http://${authority}:${address.port}/`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
