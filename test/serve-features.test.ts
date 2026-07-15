import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createViewerFeatures, ViewerExtensionRegistry } from '../src/serve/features.js';
import { createRouter, type FeatureModule } from '../src/serve/router.js';

/** Tiny response recorder for exercising the server-extension seam through the real router. */
class FakeRes {
  statusCode = 200;
  body = '';
  setHeader(): void {}
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

function requestFor(url: string): IncomingMessage {
  return { method: 'GET', url } as IncomingMessage;
}

async function request(router: ReturnType<typeof createRouter>, url: string): Promise<FakeRes> {
  const res = new FakeRes();
  await router(requestFor(url), res as unknown as ServerResponse);
  return res;
}

function routeFeature(name: string, path: string, body: string): FeatureModule {
  return {
    name,
    routes: [{ path, handler: (_req, res) => { res.end(body); } }],
  };
}

describe('fixed M5 server extension seams', () => {
  it('mounts V4 and V5 route modules through separately owned slots', async () => {
    const extensions = new ViewerExtensionRegistry();
    extensions.register('evidence', routeFeature('evidence-api', '/api/evidence', 'evidence'));
    extensions.register('impact', routeFeature('impact-api', '/api/impact', 'impact'));

    const fallback: FeatureModule = {
      name: 'assets',
      fallback: (_req, res) => { res.end('asset'); },
    };
    const router = createRouter([...extensions.modules(), fallback]);

    expect(extensions.modules().map((feature) => feature.name)).toEqual(['evidence-api', 'impact-api']);
    expect((await request(router, '/api/evidence')).body).toBe('evidence');
    expect((await request(router, '/api/impact')).body).toBe('impact');
    expect((await request(router, '/')).body).toBe('asset');
  });

  it('keeps extension ownership and the V3 asset fallback fail-closed', () => {
    const extensions = new ViewerExtensionRegistry();
    extensions.register('evidence', routeFeature('evidence-api', '/api/evidence', 'evidence'));

    expect(() =>
      extensions.register('evidence', routeFeature('second-evidence', '/api/other-evidence', 'other')),
    ).toThrow(/already registered/);
    expect(() =>
      extensions.register('impact', {
        name: 'invalid-fallback',
        fallback: (_req, res) => { res.end('never'); },
      }),
    ).toThrow(/cannot register the static-asset fallback/);
  });

  it('keeps V3 composition at graph, fixed extensions, then static assets', () => {
    expect(createViewerFeatures('/tmp/archmap-viewer-test').map((feature) => feature.name)).toEqual([
      'graph-api',
      'viewer-assets',
    ]);
  });
});
