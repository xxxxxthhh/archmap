import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadManifestFile } from '../src/validate/load.js';
import { toCanonicalJson } from '../src/model/canonical.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

describe('canonical serialization', () => {
  it('round-trips the valid fixture to its committed golden byte-for-byte', () => {
    const manifest = loadManifestFile(join(fixtures, 'valid/manifest.yaml'));
    const golden = readFileSync(join(fixtures, 'valid/manifest.canonical.json'), 'utf8');
    expect(toCanonicalJson(manifest)).toBe(golden);
  });

  it('is idempotent: canonicalizing canonical output is stable', () => {
    const manifest = loadManifestFile(join(fixtures, 'valid/manifest.yaml'));
    const once = toCanonicalJson(manifest);
    const twice = toCanonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it('is insensitive to input key order', () => {
    const a = { schema_version: 1, nodes: [] };
    const b = { nodes: [], schema_version: 1 };
    expect(toCanonicalJson(a)).toBe(toCanonicalJson(b));
  });
});
