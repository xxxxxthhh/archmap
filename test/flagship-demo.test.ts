import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRecord,
  createDisposableCopy,
  removeOwnedCopy,
  renderSiteData,
  runWalkthrough,
  SAMPLE_DIR,
  SITE_DATA_PATH,
  TEMP_PREFIX,
} from '../scripts/flagship-demo.mjs';

// The flagship demo generator drives the real CLI. Here it runs the source entry point through
// tsx (the unit suite runs before `npm run build`); `npm run demo` uses the built dist/ binary.
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI = [process.execPath, '--import', TSX_IMPORT, BIN];

function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, entry.name);
      hash.update(relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function loadShippedRecord(): { text: string; data: Record<string, unknown> } {
  const text = readFileSync(SITE_DATA_PATH, 'utf8');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return { text, data: JSON.parse(json) as Record<string, unknown> };
}

describe('flagship demo generator', () => {
  it(
    'records a real clean -> stale -> clean transition in its own disposable copy',
    () => {
      const sampleBefore = treeDigest(SAMPLE_DIR);
      const { owned, root } = createDisposableCopy();
      try {
        expect(dirname(owned)).toBe(realpathSync(tmpdir()));
        const result = runWalkthrough(root, { cli: CLI });
        const step = (id: string) => result.steps.find((s) => s.id === id)!;

        expect(step('status-clean').exit_code).toBe(0);
        expect(step('status-clean').output.clean).toBe(true);

        const stale = step('status-stale');
        expect(stale.exit_code).toBe(1);
        expect(stale.output.clean).toBe(false);
        expect(stale.output.diff.modified).toEqual(['src/loans/policy.ts']);
        const policyNode = step('impact').output.impacted.find(
          (e: { title: string }) => e.title === 'src/loans/policy.ts',
        );
        expect(stale.output.stale_nodes).toContain(policyNode.id);

        expect(step('rescan').output.base_commit).toBe(result.editCommit);
        expect(step('status-fresh').exit_code).toBe(0);
        expect(step('status-fresh').output.clean).toBe(true);

        // The shipped homepage data must be exactly what the generator produces today.
        const regenerated = renderSiteData(buildRecord(result, root));
        expect(regenerated, 'site/demo-data.js is stale; run `npm run demo -- --write-site`').toBe(
          loadShippedRecord().text,
        );
      } finally {
        removeOwnedCopy(owned);
      }
      expect(existsSync(owned)).toBe(false);
      expect(treeDigest(SAMPLE_DIR)).toBe(sampleBefore);
    },
    120_000,
  );

  it('refuses to remove a look-alike temp directory it did not create', () => {
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
    const sentinel = join(foreign, 'sentinel.txt');
    writeFileSync(sentinel, 'not the demo generator’s');
    try {
      expect(() => removeOwnedCopy(foreign)).toThrow(/refusing to remove/);
      expect(() => removeOwnedCopy(SAMPLE_DIR)).toThrow(/refusing to remove/);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('ships sanitized, labelled data with no local paths or random ids', () => {
    const { text, data } = loadShippedRecord();
    expect(data.recorded).toBe(true);
    expect(data.synthetic).toBe(true);

    const forbidden = [realpathSync(tmpdir()), tmpdir(), homedir(), '/Users/', '/home/', '/private/', '/var/folders/', 'C:\\'];
    for (const needle of forbidden) {
      if (needle.length > 1) expect(text.includes(needle), `site data contains ${needle}`).toBe(false);
    }
    expect(text).not.toMatch(/proj_[0-9a-f]{12}/);
    expect(text).not.toMatch(/archmap-demo-[A-Za-z0-9]{6}/);
  });
});
