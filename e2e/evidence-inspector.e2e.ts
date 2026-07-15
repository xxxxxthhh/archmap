import { test, expect } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FIXTURE = join(ROOT, 'fixtures', 'viewer-evidence-repo');
const BIN = join(ROOT, 'src', 'cli', 'bin.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let server: ChildProcess;
let baseURL: string;

test.beforeAll(async () => {
  server = spawn(process.execPath, ['--import', TSX, BIN, 'serve', '--port', '0'], { cwd: FIXTURE });
  baseURL = await new Promise<string>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
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
});

test('selects nodes and exact relation evidence with durable deep links and inert excerpts', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.getByTestId('map')).toBeVisible();

  await page.getByTestId('group-toggle-component').click();
  await page.getByTestId('node-node_api').locator('.node-toggle').click();

  const inspector = page.getByTestId('evidence-inspector');
  await expect(inspector).toHaveAttribute('data-evidence-target', 'node_api');
  await expect(inspector).toContainText('fact');
  await expect(inspector).toContainText('inference');
  await expect(inspector).toContainText('stale');
  await expect(inspector).toContainText('agent');
  await expect(inspector).toContainText('‹script›');
  expect(page.url()).toContain('evidence=node_api');

  await page.reload();
  await expect(inspector).toHaveAttribute('data-evidence-target', 'node_api');

  await page.getByTestId('group-toggle-component').click();
  await page.getByTestId('node-node_api').locator('.node-toggle').click();
  await page.locator('[data-evidence-target="rel_api_reads_db"]').click();
  await expect(inspector).toHaveAttribute('data-evidence-target', 'rel_api_reads_db');
  await expect(inspector).toContainText('relation evidence');
  await expect(inspector).toContainText('known');
  expect(page.url()).toContain('evidence=rel_api_reads_db');

  const xss = await page.evaluate(() => (window as unknown as { __evidenceXss?: boolean }).__evidenceXss);
  expect(xss).toBeUndefined();
  expect(await page.locator('script:not([src])').count()).toBe(0);
});
