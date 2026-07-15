import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImpactCommand } from '../src/cli/impact-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import type { Evidence, Node } from '../src/model/types.js';
import { readTrackedBaseline } from '../src/scan/baseline.js';
import { startViewerServer, type RunningViewer } from '../src/serve/index.js';
import { writeNodes } from '../src/store.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'viewer-impact-repo');
const running: RunningViewer[] = [];
const repositories: string[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close().catch(() => {});
  while (repositories.length > 0) rmSync(repositories.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function nodeForPath(nodes: Node[], path: string): Node {
  const node = nodes.find(
    (candidate) => candidate.kind === 'module' && candidate.scope?.files?.length === 1 && candidate.scope.files[0] === path,
  );
  if (!node) throw new Error(`missing scanned module for ${path}`);
  return node;
}

function firstEvidence(node: Node): Evidence {
  const evidence = node.claims.flatMap((claim) => claim.evidence)[0] ?? node.relations.flatMap((relation) => relation.evidence ?? [])[0];
  if (!evidence) throw new Error(`missing evidence for ${node.id}`);
  return evidence;
}

function enrichViewerModel(root: string): { apiId: string; workerId: string; rootId: string } {
  const baseline = readTrackedBaseline(root);
  if (!baseline) throw new Error('expected scanned baseline');
  const api = nodeForPath(baseline.nodes, 'src/api.ts');
  const worker = nodeForPath(baseline.nodes, 'src/worker.ts');
  const nodes = baseline.nodes.map((node) => {
    if (node.id === api.id) {
      return {
        ...node,
        claims: [
          ...node.claims,
          {
            id: 'claim_api_agent',
            type: 'inference' as const,
            text: 'Agent-maintained boundary interpretation.',
            status: 'active' as const,
            confidence: 0.82,
            provenance: { actor: 'agent' as const, model: 'fixture-model', created_at: '2026-07-15T00:00:00Z' },
            evidence: [firstEvidence(api)],
          },
        ],
      };
    }
    if (node.id === worker.id) {
      return {
        ...node,
        claims: [
          ...node.claims,
          {
            id: 'claim_worker_human_stale',
            type: 'inference' as const,
            text: 'Human-maintained worker note.',
            status: 'stale' as const,
            confidence: 0.6,
            provenance: { actor: 'human' as const, created_at: '2026-07-15T00:00:00Z' },
            evidence: [firstEvidence(worker)],
          },
        ],
      };
    }
    return node;
  });
  writeNodes(root, nodes);
  const rootNode = nodes.find((node) => node.kind === 'system');
  if (!rootNode) throw new Error('missing repository root node');
  return { apiId: api.id, workerId: worker.id, rootId: rootNode.id };
}

function prepareRepository(options: { dirty?: boolean } = {}): { root: string; apiId: string; workerId: string; rootId: string } {
  const root = mkdtempSync(join(tmpdir(), 'archmap-viewer-impact-'));
  repositories.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Viewer Fixture']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'viewer impact fixture']);
  expect(runInit([], { cwd: root }).exitCode).toBe(0);
  expect(runScanCommand([], { cwd: root }).exitCode).toBe(0);
  const ids = enrichViewerModel(root);
  if (options.dirty) appendFileSync(join(root, 'src', 'worker.ts'), '\n// changed after scan\n');
  return { root, ...ids };
}

async function start(cwd: string): Promise<RunningViewer> {
  const viewer = await startViewerServer({ cwd, port: 0 });
  running.push(viewer);
  return viewer;
}

describe('V5 impact and filter viewer APIs', () => {
  it('matches the CLI impact JSON semantics for the same repository path', async () => {
    const repository = prepareRepository();
    const viewer = await start(repository.root);
    const response = await fetch(`${viewer.url}api/impact?path=${encodeURIComponent('src/api.ts')}`);
    expect(response.status).toBe(200);
    const served = (await response.json()) as { impacted: Array<{ id: string }> };
    const cli = JSON.parse(runImpactCommand(['src/api.ts', '--json'], { cwd: repository.root }).stdout);
    expect(served).toEqual(cli);
    expect(served.impacted.some((entry: { id: string }) => entry.id === repository.apiId)).toBe(true);
  });

  it('exposes only factual filter facets and keeps status staleness distinct from claim staleness', async () => {
    const repository = prepareRepository({ dirty: true });
    const viewer = await start(repository.root);
    const response = await fetch(`${viewer.url}api/viewer-filters`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      command: string;
      status: { clean: boolean; stale_nodes: string[] };
      nodes: Array<{
        id: string;
        actors: string[];
        claims: Array<{ id: string; type: string; status: string; confidence: number; actor: string }>;
        stale: { claim: boolean; status: boolean };
      }>;
      relations: Array<{ id: string; source: string; target: string; type: string; certainty: string; actor: string }>;
    };

    expect(body.command).toBe('viewer-filters');
    expect(body.status.clean).toBe(false);
    expect(body.status.stale_nodes).toContain(repository.workerId);
    expect(body.status.stale_nodes).toContain(repository.rootId);
    expect(body.nodes.find((node) => node.id === repository.workerId)).toMatchObject({
      actors: expect.arrayContaining(['analyzer', 'human']),
      claims: expect.arrayContaining([
        { id: 'claim_worker_human_stale', type: 'inference', status: 'stale', confidence: 0.6, actor: 'human' },
      ]),
      stale: { claim: true, status: true },
    });
    expect(body.nodes.find((node) => node.id === repository.rootId)?.stale).toEqual({ claim: false, status: true });
    expect(body.nodes.find((node) => node.id === repository.apiId)?.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claim_api_agent', type: 'inference', confidence: 0.82, actor: 'agent' }),
    ]));
    expect(body.relations.some((relation) => relation.actor === 'analyzer')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Human-maintained worker note.');
  });

  it('fails closed for missing or escaping impact paths and keeps the GET-only router boundary', async () => {
    const repository = prepareRepository();
    const viewer = await start(repository.root);
    for (const path of ['/api/impact', '/api/impact?path=../../etc/passwd']) {
      const response = await fetch(`${viewer.url.slice(0, -1)}${path}`);
      expect(response.status, path).toBe(400);
    }
    const mutating = await fetch(`${viewer.url}api/impact?path=src%2Fapi.ts`, { method: 'POST' });
    expect(mutating.status).toBe(405);
    expect(mutating.headers.get('allow')).toBe('GET');
  });

  it('neutralizes a hostile impacted title before it reaches the browser endpoint', async () => {
    const repository = prepareRepository();
    const baseline = readTrackedBaseline(repository.root);
    if (!baseline) throw new Error('expected scanned baseline');
    writeNodes(repository.root, baseline.nodes.map((node) => (
      node.id === repository.apiId ? { ...node, title: '<script>window.__xss=1</script>' } : node
    )));
    const viewer = await start(repository.root);
    const body = await (await fetch(`${viewer.url}api/impact?path=src%2Fapi.ts`)).text();
    expect(body).not.toContain('<script>');
    // The harmless text remains readable, but the active tag opener does not survive the
    // browser-facing projection (and the client uses textContent when it renders a result).
    expect(body).toContain('‹script›window.__xss=1‹/script›');
    expect(JSON.parse(body).impacted.some((entry: { id: string }) => entry.id === repository.apiId)).toBe(true);
  });
});
