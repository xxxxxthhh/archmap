import { test, expect } from '@playwright/test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURE = join(ROOT, 'fixtures', 'viewer-diff-repo');
const BIN = join(ROOT, 'src', 'cli', 'bin.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let server: ChildProcess;
let repository: string;
let baseURL: string;
let baseRef: string;
let headRef: string;

test.setTimeout(45_000);

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', env });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

function writeState(state: 'base' | 'head'): void {
  rmSync(join(repository, '.archmap'), { recursive: true, force: true });
  cpSync(join(FIXTURE, state, '.archmap'), join(repository, '.archmap'), { recursive: true });
  // The V6 diff fixture is intentionally minimal for direct engine tests. The browser's graph
  // route additionally validates the normal M1 structural invariant, so the disposable E2E
  // history supplies the unchanged repository system node without widening the shared fixture.
  writeFileSync(join(repository, '.archmap', 'nodes', 'node_cdb4ee2aea69cc6a.yaml'), [
    'claims: []',
    'id: node_cdb4ee2aea69cc6a',
    'kind: system',
    'relations: []',
    'schema_version: 1',
    'slug: repository',
    'title: Viewer Diff Repo',
    '',
  ].join('\n'));
}

function commitState(state: 'base' | 'head', date: string): string {
  writeState(state);
  if (state === 'head') {
    const changedNode = join(repository, '.archmap', 'nodes', 'node_changed.yaml');
    const text = readFileSync(changedNode, 'utf8').replace(
      'title: After title',
      'title: "<img src=x onerror=window.__diffXss=1>"',
    );
    writeFileSync(changedNode, text);
  }
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', `viewer diff ${state}`], {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(['rev-parse', 'HEAD']);
}

async function startServer(): Promise<string> {
  server = spawn(process.execPath, ['--import', TSX, BIN, 'serve', '--port', '0'], { cwd: repository });
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        server.stdout?.off('data', onData);
        resolve(match[0]);
      }
    };
    server.stdout?.on('data', onData);
    server.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    server.once('exit', (code) => reject(new Error(`viewer exited early (${code}): ${stderr.trim()}`)));
    setTimeout(() => reject(new Error('viewer did not report a URL in time')), 20_000);
  });
}

async function compare(page: import('@playwright/test').Page, base: string, head: string): Promise<void> {
  await page.getByTestId('diff-base').fill(base);
  await page.getByTestId('diff-head').fill(head);
  await page.getByTestId('run-diff').click();
  await expect(page.getByTestId('diff-results')).toHaveAttribute('data-diff-state', 'ready');
}

test.beforeAll(async () => {
  repository = mkdtempSync(join(tmpdir(), 'archmap-viewer-diff-e2e-'));
  git(['init', '--quiet']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Viewer Diff Fixture']);
  baseRef = commitState('base', '2026-07-16T00:00:00Z');
  headRef = commitState('head', '2026-07-16T00:01:00Z');
  baseURL = await startServer();
});

test.afterAll(() => {
  server?.kill('SIGTERM');
  if (repository) rmSync(repository, { recursive: true, force: true });
});

test('renders the exact prepared node and relation buckets through the loopback viewer', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));

  await page.goto(baseURL);
  await expect(page.getByTestId('viewer-diff')).toBeVisible();
  await compare(page, baseRef, headRef);

  await expect(page.getByTestId('diff-nodes-added')).toContainText('node_added');
  await expect(page.getByTestId('diff-nodes-removed')).toContainText('node_removed');
  await expect(page.getByTestId('diff-nodes-changed')).toContainText('node_changed');
  await expect(page.getByTestId('diff-relations-added')).toContainText('rel_added');
  await expect(page.getByTestId('diff-relations-removed')).toContainText('rel_removed');
  await expect(page.getByTestId('diff-relations-changed')).toContainText('rel_changed');
  await expect(page.getByTestId('diff-relations-changed')).toContainText('certainty: partial');
  await expect(page.getByTestId('diff-claims-added')).toContainText('claim_added');
  await expect(page.getByTestId('diff-claims-added')).toContainText('status: active');
  await expect(page.getByTestId('diff-claims-stale')).toContainText('claim_stale');
  await expect(page.getByTestId('diff-claims-stale')).toContainText('status: stale');
  expect(origins).toEqual(new Set([new URL(baseURL).origin]));
});

test('renders an explicit readable empty state for identical references', async ({ page }) => {
  await page.goto(baseURL);
  await compare(page, baseRef, baseRef);
  await expect(page.getByTestId('diff-empty')).toBeVisible();
  await expect(page.getByTestId('diff-empty')).toContainText('No architectural changes');
});

test('keeps hostile diff display values inert in the real browser', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });

  await page.goto(baseURL);
  await compare(page, baseRef, headRef);

  await expect(page.getByTestId('diff-nodes-changed')).toContainText('‹img src=x onerror=window.__diffXss=1›');
  await expect(page.getByTestId('diff-claims-added')).toContainText('‹script›window.__diffClaim=1‹/script›');
  expect(await page.getByTestId('diff-nodes-changed').locator('img').count()).toBe(0);
  expect(await page.getByTestId('diff-claims-added').locator('script').count()).toBe(0);
  const html = await page.content();
  expect(html).not.toContain('<img src=x onerror=window.__diffXss=1>');
  const xss = await page.evaluate(() => (window as unknown as { __diffXss?: number }).__diffXss);
  expect(xss).toBeUndefined();
  expect(dialogFired).toBe(false);
});
