import { test, expect } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * First browser navigation + content-safety smoke for the loopback viewer (Issue #30).
 *
 * Drives the real shipped path — the `archmap serve` CLI, bound to an ephemeral loopback port —
 * and a real Chromium. The fixture is a copy of `viewer-repo` with one node given an active-markup
 * title and claim, so a single server proves both required behaviors: the interactive expand of a
 * collapsed group, and that a hostile repository payload renders inert (no script runs, no dialog
 * fires, no remote request) under the served CSP.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURE = join(ROOT, 'fixtures', 'viewer-repo');
const BIN = join(ROOT, 'src', 'cli', 'bin.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let server: ChildProcess;
let repoDir: string;
let baseURL: string;

/** Build a copy of the fixture whose `node_payments` carries an active-markup title and claim. */
function hostileFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-e2e-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const nodePath = join(dir, '.archmap', 'nodes', 'node_payments.yaml');
  const node = readFileSync(nodePath, 'utf8')
    .replace('title: Payments API', 'title: "<img src=x onerror=window.__xss=1>"')
    .replace(
      'text: External payment provider dependency.',
      'text: "![p](https://evil.example/pixel) <script>window.__xss=1</script>"',
    );
  writeFileSync(nodePath, node);
  return dir;
}

test.beforeAll(async () => {
  repoDir = hostileFixture();
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

test('opens the map and expands a collapsed group', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(baseURL);
  await expect(page.getByTestId('map')).toBeVisible();

  // The component group ships collapsed: its body is hidden until the header is clicked.
  const body = page.getByTestId('group-body-component');
  await expect(body).toBeHidden();
  await page.getByTestId('group-toggle-component').click();
  await expect(body).toBeVisible();
  await expect(page.getByText('API Service')).toBeVisible();

  expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('initializes separately mountable V4/V5 client slots', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.getByTestId('map')).toBeVisible();

  // The V3 host imports and calls each fixed extension module after the graph renders. Future
  // slices own these independent modules and DOM slots, so neither needs to edit viewer/app.js.
  for (const slot of ['viewer-slot-evidence', 'viewer-slot-filters', 'viewer-slot-diff']) {
    await expect(page.getByTestId(slot)).toHaveAttribute('data-feature-mounted', 'true');
  }
});

test('selects a lowercase-slug named view through the canonical page URL', async ({ page }) => {
  const graphRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/graph') graphRequests.push(request.url());
  });

  await page.goto(`${baseURL}?keep=yes#architecture`);
  await expect(page.getByTestId('map')).toBeVisible();
  await page.getByTestId('view-id').fill('api-paths');
  await page.getByTestId('view-form').getByRole('button', { name: 'Apply' }).click();

  await expect(page).toHaveURL(`${baseURL}?keep=yes&view=api-paths#architecture`);
  await expect(page.getByTestId('status')).toContainText('view "api-paths"');
  await expect(page.locator('[data-node-id]')).toHaveCount(2);
  await expect(page.getByTestId('node-node_api')).toHaveCount(1);
  await expect(page.getByTestId('node-node_api_handlers')).toHaveCount(1);
  await expect(page.getByTestId('node-node_payments')).toHaveCount(0);
  expect(graphRequests.at(-1)).toBe(`${baseURL}api/graph?view=api-paths`);

  await page.getByTestId('view-default').click();
  await expect(page).toHaveURL(`${baseURL}?keep=yes#architecture`);
  await expect(page.getByTestId('status')).toContainText('view "default"');
  expect(graphRequests.at(-1)).toBe(`${baseURL}api/graph`);
});

test('uses the default view for a blank selector and rejects invalid client input before graph fetch', async ({ page }) => {
  const graphRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/graph') graphRequests.push(request.url());
  });

  await page.goto(`${baseURL}?view=`);
  await expect(page.getByTestId('map')).toBeVisible();
  expect(graphRequests).toEqual([`${baseURL}api/graph`]);

  graphRequests.length = 0;
  await page.getByTestId('view-id').fill('Not-A-Slug');
  await page.getByTestId('view-form').getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('view-error')).toContainText('lowercase slug');
  expect(graphRequests).toEqual([]);

  await page.goto(`${baseURL}?view=Not-A-Slug`);
  await expect(page.getByTestId('view-error')).toContainText('lowercase slug');
  await expect(page.getByTestId('map')).toBeHidden();
  expect(graphRequests).toEqual([]);
});

test('leaves valid but missing named views to the server authority', async ({ page }) => {
  await page.goto(`${baseURL}?view=does-not-exist`);
  await expect(page.getByTestId('status')).toHaveText('Could not load map: view: view not found');
  await expect(page.getByTestId('map')).toBeHidden();
});

test('renders hostile repository content inert (no script executes)', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', (d) => {
    dialogFired = true;
    void d.dismiss();
  });

  await page.goto(baseURL);
  // Reveal the node that carries the hostile title (external group, then its card).
  await page.getByTestId('group-toggle-external').click();
  await expect(page.getByTestId('node-node_payments')).toBeVisible();

  // The payload was neutralized to inert text: the literal tag-opener is gone from the DOM, no
  // injected global was set, and no dialog fired.
  const html = await page.content();
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>window.__xss');
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
  expect(dialogFired).toBe(false);
});
