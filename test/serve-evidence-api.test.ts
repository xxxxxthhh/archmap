import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Evidence } from '../src/model/types.js';
import { evidenceFor } from '../src/query/queries.js';
import { loadTrackedProject } from '../src/query/project.js';
import { startViewerServer, type RunningViewer } from '../src/serve/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'viewer-evidence-repo');

const running: RunningViewer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close().catch(() => {});
});

async function start(): Promise<RunningViewer> {
  const viewer = await startViewerServer({ cwd: FIXTURE, port: 0 });
  running.push(viewer);
  return viewer;
}

function rawGet(
  viewer: RunningViewer,
  path: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: viewer.host, port: viewer.port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function cliEvidence(target: string): Evidence[] {
  const loaded = loadTrackedProject(FIXTURE);
  if (!loaded.ok) throw new Error(loaded.error);
  return evidenceFor(loaded.baseline.nodes, target).evidence;
}

interface EvidencePayload {
  schema_version: number;
  target: string;
  found: boolean;
  matched: 'node' | 'claim' | 'relation';
  node: { id: string; kind: string; title: string };
  claims: Array<{
    id: string;
    type: 'fact' | 'inference';
    status: 'active' | 'stale' | 'rejected';
    provenance: { actor: 'analyzer' | 'agent' | 'human' };
  }>;
  relations: Array<{
    id: string;
    type: string;
    certainty: 'known' | 'partial' | 'unknown';
    provenance: { actor: 'analyzer' | 'agent' | 'human' | 'unknown' };
  }>;
  evidence: Evidence[];
  excerpts: Array<{ index: number; status: 'available' | 'unavailable'; text?: string; truncated?: boolean }>;
}

async function evidence(viewer: RunningViewer, target: string): Promise<EvidencePayload> {
  const response = await fetch(`${viewer.url}api/evidence?target=${encodeURIComponent(target)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as EvidencePayload;
}

describe('V4 evidence inspector API', () => {
  it('returns the exact CLI evidence identities plus safe bounded excerpts for a node', async () => {
    const viewer = await start();
    const body = await evidence(viewer, 'node_api');

    expect(body).toMatchObject({
      schema_version: 1,
      target: 'node_api',
      found: true,
      matched: 'node',
      node: { id: 'node_api', kind: 'component', title: 'Evidence API' },
    });
    expect(body.evidence).toEqual(cliEvidence('node_api'));
    expect(body.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claim_api_fact',
          type: 'fact',
          status: 'active',
          provenance: expect.objectContaining({ actor: 'analyzer' }),
        }),
        expect.objectContaining({
          id: 'claim_api_inference',
          type: 'inference',
          status: 'stale',
          provenance: expect.objectContaining({ actor: 'agent' }),
        }),
      ]),
    );
    expect(body.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'rel_api_reads_db',
          certainty: 'known',
          provenance: expect.objectContaining({ actor: 'analyzer' }),
        }),
        expect.objectContaining({
          id: 'rel_api_calls_external',
          certainty: 'partial',
          provenance: expect.objectContaining({ actor: 'unknown' }),
        }),
      ]),
    );
    expect(body.excerpts[0]).toMatchObject({
      index: 0,
      status: 'available',
      text: expect.stringContaining('‹script›'),
    });
    expect(JSON.stringify(body)).not.toContain('<script>');
    expect(JSON.stringify(body)).not.toContain('https://evil.example');
  });

  it('resolves an edge to its own relation evidence rather than a node claim', async () => {
    const viewer = await start();
    const body = await evidence(viewer, 'rel_api_reads_db');

    expect(body.matched).toBe('relation');
    expect(body.node.id).toBe('node_api');
    expect(body.claims).toEqual([]);
    expect(body.relations).toEqual([
      expect.objectContaining({ id: 'rel_api_reads_db', type: 'reads', certainty: 'known' }),
    ]);
    expect(body.evidence).toEqual(cliEvidence('rel_api_reads_db'));
    expect(body.evidence).not.toContainEqual(expect.objectContaining({ extract_hash: 'sha256:extract-src-api-fact' }));
  });

  it('preserves partial/unknown evidence gaps without inventing a deterministic fallback', async () => {
    const viewer = await start();
    const body = await evidence(viewer, 'rel_api_calls_external');

    expect(body.matched).toBe('relation');
    expect(body.claims).toEqual([]);
    expect(body.relations).toEqual([
      expect.objectContaining({
        id: 'rel_api_calls_external',
        certainty: 'partial',
        provenance: expect.objectContaining({ actor: 'unknown' }),
      }),
    ]);
    expect(body.evidence).toEqual([]);
    expect(body.excerpts).toEqual([]);
  });

  it('fails closed for missing, ambiguous, unknown, and path-escaping source requests', async () => {
    const viewer = await start();

    for (const path of ['/api/evidence', '/api/evidence?target=node_api&target=node_db', '/api/evidence?target=missing']) {
      const response = await fetch(`${viewer.url}${path.slice(1)}`);
      expect([400, 404]).toContain(response.status);
      expect(await response.json()).toEqual(expect.objectContaining({ error: expect.any(String) }));
    }

    const escaped = await evidence(viewer, 'claim_escape_fact');
    expect(escaped.evidence[0]).toEqual(expect.objectContaining({ path: '../../package.json' }));
    expect(escaped.excerpts).toEqual([{ index: 0, status: 'unavailable' }]);

    const writeAttempt = await rawGet(viewer, '/api/evidence?target=node_api', 'POST');
    expect(writeAttempt.status).toBe(405);
  });
});
