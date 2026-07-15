import { test, expect } from '@playwright/test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import type { Evidence, Node } from '../src/model/types.js';
import { readTrackedBaseline } from '../src/scan/baseline.js';
import { writeNodes } from '../src/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURE = join(ROOT, 'fixtures', 'viewer-impact-repo');
const BIN = join(ROOT, 'src', 'cli', 'bin.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let server: ChildProcess;
let repoDir: string;
let baseURL: string;
let apiId: string;
let workerId: string;

test.setTimeout(45_000);

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
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

function prepareRepository(): void {
  repoDir = mkdtempSync(join(tmpdir(), 'archmap-viewer-impact-e2e-'));
  cpSync(FIXTURE, repoDir, { recursive: true });
  git(['init']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Viewer Fixture']);
  git(['add', '-A']);
  git(['commit', '-m', 'viewer impact fixture']);
  if (runInit([], { cwd: repoDir }).exitCode !== 0) throw new Error('init failed');
  if (runScanCommand([], { cwd: repoDir }).exitCode !== 0) throw new Error('scan failed');

  const baseline = readTrackedBaseline(repoDir);
  if (!baseline) throw new Error('missing scanned baseline');
  const api = nodeForPath(baseline.nodes, 'src/api.ts');
  const worker = nodeForPath(baseline.nodes, 'src/worker.ts');
  apiId = api.id;
  workerId = worker.id;
  writeNodes(repoDir, baseline.nodes.map((node) => {
    if (node.id === api.id) {
      return {
        ...node,
        claims: [...node.claims, {
          id: 'claim_api_agent',
          type: 'inference' as const,
          text: 'Agent-maintained boundary interpretation.',
          status: 'active' as const,
          confidence: 0.82,
          provenance: { actor: 'agent' as const, model: 'fixture-model', created_at: '2026-07-15T00:00:00Z' },
          evidence: [firstEvidence(api)],
        }],
      };
    }
    if (node.id === worker.id) {
      return {
        ...node,
        claims: [...node.claims, {
          id: 'claim_worker_human_stale',
          type: 'inference' as const,
          text: 'Human-maintained worker note.',
          status: 'stale' as const,
          confidence: 0.6,
          provenance: { actor: 'human' as const, created_at: '2026-07-15T00:00:00Z' },
          evidence: [firstEvidence(worker)],
        }],
      };
    }
    return node;
  }));

  // This drives the pre-existing read-only `status` query: stale state is not a V5 guess.
  appendFileSync(join(repoDir, 'src', 'worker.ts'), '\n// changed after scan\n');
}

test.beforeAll(async () => {
  prepareRepository();
  server = spawn(process.execPath, ['--import', TSX, BIN, 'serve', '--port', '0'], { cwd: repoDir });
  baseURL = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const match = buf.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        server.stdout?.off('data', onData);
        resolve(match[0]);
      }
    };
    server.stdout?.on('data', onData);
    server.once('exit', (code) => reject(new Error(`viewer exited early (${code})`)));
    setTimeout(() => reject(new Error('viewer did not report a URL in time')), 20_000);
  });
});

test.afterAll(() => {
  server?.kill('SIGTERM');
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

test('filters nodes and relations without relabelling their provenance or certainty', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await page.goto(baseURL);
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('filter-controls')).toBeVisible();

  // The V5 stale filter combines authored stale claims with the exact CLI-status stale set.
  await page.getByTestId('filter-stale').selectOption('stale');
  await page.getByTestId('filter-provenance').selectOption('human');
  await page.getByTestId('group-toggle-module').click();
  const worker = page.getByTestId(`node-${workerId}`);
  await expect(worker).toBeVisible();
  await expect(page.getByTestId(`node-${apiId}`)).toBeHidden();
  await worker.locator('.node-toggle').click();
  await expect(worker.getByText('[inference/stale]')).toBeVisible();
  await expect(worker.getByText('src/worker.ts')).toBeVisible();

  // Restore the independent filters, then prove a relation-type choice hides nonmatching rows.
  await page.getByTestId('filter-stale').selectOption('all');
  await page.getByTestId('filter-provenance').selectOption('all');
  await page.getByTestId('filter-relation').selectOption('imports');
  const importEdge = worker.locator('[data-edge-type="imports"]');
  await expect(importEdge).toBeVisible();
  await page.getByTestId('filter-relation').selectOption('reads');
  await expect(importEdge).toBeHidden();

  expect(origins).toEqual(new Set([new URL(baseURL).origin]));
});

test('shows CLI-equivalent impact highlights and a useful empty filter state', async ({ page }) => {
  const pageErrors: string[] = [];
  const impactRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/impact')) impactRequests.push(request.url());
  });
  await page.goto(baseURL);
  await expect(page.getByTestId('map')).toBeVisible();
  await page.getByTestId('impact-paths').fill('src/api.ts');
  await page.getByTestId('run-impact').click();
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
  expect(impactRequests).toHaveLength(1);
  await expect(page.getByTestId('impact-results')).toContainText('Impact:');
  const api = page.getByTestId(`node-${apiId}`);
  await expect(api).toHaveAttribute('data-impact', 'true');
  await expect(api.locator('[data-impact-marker]')).toContainText('impact: directly scopes a changed file');
  // The containing kind group can remain collapsed; impact must preserve the existing label,
  // not force-open or rewrite the V3 card.
  await expect(api.getByText('src/api.ts')).toHaveText('src/api.ts');

  // The human stale claim is deliberately below the high confidence threshold, leaving a
  // readable empty state rather than mutating or clearing the underlying graph labels.
  await page.getByTestId('filter-stale').selectOption('stale');
  await page.getByTestId('filter-confidence').selectOption('high');
  await expect(page.getByTestId('filter-empty')).toBeVisible();
  await expect(page.getByTestId('filter-empty')).toContainText('architecture model is unchanged');
});
