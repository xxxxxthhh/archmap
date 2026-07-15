import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startViewerServer, type RunningViewer } from '../src/serve/index.js';
import { CONTENT_SECURITY_POLICY } from '../src/serve/content-safety.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'viewer-repo');

const running: RunningViewer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const viewer = running.pop()!;
    await viewer.close().catch(() => {});
  }
});

async function start(cwd = FIXTURE): Promise<RunningViewer> {
  const viewer = await startViewerServer({ cwd, port: 0 });
  running.push(viewer);
  return viewer;
}

/** Raw HTTP GET that sends `rawPath` verbatim (fetch would normalize dot-segments away). */
function rawGet(base: RunningViewer, rawPath: string, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.host, port: base.port, path: rawPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every byte under `.archmap`, for proving a request sweep wrote nothing. */
function archmapBytes(root: string): Array<[string, string]> {
  const dir = join(root, '.archmap');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  return files.sort().map((p) => [relative(dir, p), readFileSync(p).toString('base64')]);
}

describe('loopback binding', () => {
  it('binds 127.0.0.1 on an ephemeral port and reports the actual address', async () => {
    const viewer = await start();
    expect(viewer.host).toBe('127.0.0.1');
    expect(viewer.port).toBeGreaterThan(0);
    expect(viewer.url).toBe(`http://127.0.0.1:${viewer.port}/`);
  });

  it('refuses to bind a wildcard / any address', async () => {
    for (const host of ['0.0.0.0', '::', '']) {
      await expect(startViewerServer({ cwd: FIXTURE, host, port: 0 })).rejects.toThrow(/non-loopback/);
    }
  });
});

describe('read-only JSON API', () => {
  it('serves the display-graph projection with a schema version and full stats', async () => {
    const viewer = await start();
    const res = await fetch(`${viewer.url}api/graph`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    const body = (await res.json()) as {
      schema_version: number;
      projection: { stats: { total_nodes: number; visible_nodes: number }; nodes: unknown[] };
    };
    expect(body.schema_version).toBe(1);
    expect(body.projection.stats.total_nodes).toBe(7);
    expect(body.projection.stats.visible_nodes).toBe(7);
    expect(body.projection.nodes.length).toBe(7);
  });

  it('refuses every mutating method with 405 (read-only boundary)', async () => {
    const viewer = await start();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await rawGet(viewer, '/api/graph', method);
      expect(res.status, method).toBe(405);
      expect(res.headers['allow'], method).toBe('GET');
    }
  });

  it('fails closed (400) on a path-escaping view selector', async () => {
    const viewer = await start();
    const res = await fetch(`${viewer.url}api/graph?view=${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('invalid view id');
  });

  it('fails closed (409) when the target directory is not a scanned project', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-serve-empty-')));
    try {
      const viewer = await start(dir);
      const res = await fetch(`${viewer.url}api/graph`);
      expect(res.status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bundled static assets (local, pinned, no remote origin)', () => {
  it('serves the viewer shell, script, and stylesheet with correct content types', async () => {
    const viewer = await start();
    const cases: Array<[string, string]> = [
      ['', 'text/html'],
      ['index.html', 'text/html'],
      ['app.js', 'text/javascript'],
      ['style.css', 'text/css'],
    ];
    for (const [path, type] of cases) {
      const res = await fetch(`${viewer.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type);
      expect(res.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
    }
  });

  it('references no remote origin from any served asset (offline / no-CDN)', async () => {
    const viewer = await start();
    for (const path of ['', 'app.js', 'style.css']) {
      const body = await (await fetch(`${viewer.url}${path}`)).text();
      expect(body, path).not.toMatch(/https?:\/\//);
    }
  });

  it('CSP forbids remote origins, inline handlers, and eval', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });
});

describe('traversal / asset exposure denial', () => {
  it('cannot reach a same-extension file outside the viewer root via encoded traversal', async () => {
    const viewer = await start();
    // eslint.config.js is a real .js file at the repo root, outside viewer/.
    const res = await rawGet(viewer, '/%2e%2e/%2e%2e/eslint.config.js');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('eslint');
  });

  it('refuses non-allowlisted extensions and dot-segment traversal', async () => {
    const viewer = await start();
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/app.js/../../package.json']) {
      const res = await rawGet(viewer, path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe('hostile repository content renders inert', () => {
  function hostileRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-serve-hostile-')));
    cpSync(FIXTURE, dir, { recursive: true });
    // Overwrite one tracked node with an active-markup title and claim body. The projection must
    // neutralize both so the served JSON carries no live payload.
    const nodePath = join(dir, '.archmap', 'nodes', 'node_payments.yaml');
    const node = readFileSync(nodePath, 'utf8')
      .replace('title: Payments API', 'title: "<img src=x onerror=alert(1)>"')
      .replace(
        'text: External payment provider dependency.',
        'text: "![p](https://evil.example/pixel) <script>steal()</script>"',
      );
    writeFileSync(nodePath, node);
    return dir;
  }

  it('never emits an active payload in the graph JSON', async () => {
    const dir = hostileRepo();
    try {
      const viewer = await start(dir);
      const body = await (await fetch(`${viewer.url}api/graph`)).text();
      // No tag-opener, link/image syntax, or fetchable remote URL survives — so nothing the
      // browser could execute or load, even before CSP and the client's textContent-only DOM.
      for (const token of ['<img', '<script', '](', '![', 'https://evil.example']) {
        expect(body, token).not.toContain(token);
      }
      // The node is still present (neutralized, not dropped).
      const parsed = JSON.parse(body) as { projection: { nodes: Array<{ id: string }> } };
      expect(parsed.projection.nodes.some((n) => n.id === 'node_payments')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('read-only: a request sweep mutates nothing on disk', () => {
  it('leaves every .archmap byte unchanged', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-serve-ro-')));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      const before = archmapBytes(dir);
      const viewer = await start(dir);
      await fetch(`${viewer.url}api/graph`);
      await fetch(`${viewer.url}`);
      await fetch(`${viewer.url}app.js`);
      await rawGet(viewer, '/api/graph', 'POST');
      expect(archmapBytes(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
