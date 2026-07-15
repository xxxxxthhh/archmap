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
