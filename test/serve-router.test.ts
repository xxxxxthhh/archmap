import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, type FeatureModule } from '../src/serve/router.js';
import { CONTENT_SECURITY_POLICY } from '../src/serve/content-safety.js';

/** A minimal fake response that records status, headers, and body — enough to exercise the seam. */
class FakeRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
}

function req(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

async function run(router: (r: IncomingMessage, s: ServerResponse) => unknown, method: string, url: string) {
  const res = new FakeRes();
  await router(req(method, url), res as unknown as ServerResponse);
  return res;
}

describe('router seam: read-only + content-safety + mountable features', () => {
  const hitFeature: FeatureModule = {
    name: 'hit',
    routes: [{ path: '/api/x', handler: (_q, res) => { res.end('x-ok'); } }],
  };
  const fallbackFeature: FeatureModule = {
    name: 'fallback-owner',
    fallback: (_q, res) => { res.end('fallback'); },
  };

  it('applies the content-safety headers to every response, including 404s', async () => {
    const router = createRouter([hitFeature]);
    const res = await run(router, 'GET', '/missing');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('refuses every non-GET method with 405 before any handler runs', async () => {
    const router = createRouter([hitFeature, fallbackFeature]);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const res = await run(router, method, '/api/x');
      expect(res.statusCode, method).toBe(405);
      expect(res.headers['allow'], method).toBe('GET');
      expect(res.body, method).not.toContain('x-ok');
    }
  });

  it('dispatches an exact route, then the single fallback', async () => {
    const router = createRouter([hitFeature, fallbackFeature]);
    expect((await run(router, 'GET', '/api/x')).body).toBe('x-ok');
    expect((await run(router, 'GET', '/anything/else')).body).toBe('fallback');
  });

  it('ignores the query string when matching a route path', async () => {
    const router = createRouter([hitFeature, fallbackFeature]);
    expect((await run(router, 'GET', '/api/x?view=default')).body).toBe('x-ok');
  });

  it('rejects overlapping mounts so a feature can never silently shadow another', () => {
    const dup: FeatureModule = { name: 'dup', routes: [{ path: '/api/x', handler: (_q, res) => { res.end(''); } }] };
    expect(() => createRouter([hitFeature, dup])).toThrow(/duplicate viewer route/);
    const secondFallback: FeatureModule = { name: 'second', fallback: (_q, res) => { res.end(''); } };
    expect(() => createRouter([fallbackFeature, secondFallback])).toThrow(/already owns it/);
  });

  it('returns 404 (not a crash) when no route and no fallback matches', async () => {
    const router = createRouter([hitFeature]);
    const res = await run(router, 'GET', '/no-fallback-here');
    expect(res.statusCode).toBe(404);
  });
});
