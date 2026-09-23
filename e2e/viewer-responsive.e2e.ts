import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Layout regression: long evidence identities, source excerpts, and filter/impact controls must
// stay inside the viewport. Long code remains readable by scrolling its own box; the page itself
// never scrolls horizontally, and nothing is clipped by hiding overflow on the page.

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

async function pageOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; bodyOverflowX: string }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
  }));
}

for (const width of [1200, 390]) {
  test(`evidence and impact stay within a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseURL);
    await expect(page.getByTestId('map')).toBeVisible();

    await page.getByTestId('group-toggle-component').click();
    await page.getByTestId('node-node_api').locator('.node-toggle').click();
    const inspector = page.getByTestId('evidence-inspector');
    await expect(inspector).toHaveAttribute('data-evidence-target', 'node_api');

    await page.getByTestId('impact-paths').fill('src/api.ts');
    await page.getByTestId('run-impact').click();
    await expect(page.getByTestId('impact-results')).not.toBeEmpty();

    const layout = await pageOverflow(page);
    expect(layout.bodyOverflowX).not.toBe('hidden');
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

    // Excerpts keep their exact bytes and scroll inside their own box.
    const excerpt = inspector.locator('pre').first();
    await expect(excerpt).toContainText('export const hostileExcerptFixture');
    const box = await excerpt.evaluate((pre) => {
      const rect = pre.getBoundingClientRect();
      return { right: rect.right, overflowX: getComputedStyle(pre).overflowX };
    });
    expect(box.right).toBeLessThanOrEqual(layout.clientWidth);
    expect(['auto', 'scroll']).toContain(box.overflowX);

    // Controls remain visible, inside the viewport, and keyboard-focusable with a visible outline.
    for (const testid of ['filter-relation', 'impact-paths', 'run-impact', 'view-id']) {
      const control = page.getByTestId(testid);
      await expect(control).toBeVisible();
      const right = await control.evaluate((node) => node.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(layout.clientWidth);
    }
    await page.getByTestId('impact-paths').focus();
    await page.keyboard.press('Tab');
    const outline = await page.getByTestId('run-impact').evaluate((node) => getComputedStyle(node).outlineStyle);
    expect(outline).not.toBe('none');
  });
}
