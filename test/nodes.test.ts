import { describe, it, expect } from 'vitest';
import { buildNodes } from '../src/scan/nodes.js';
import { validateManifest } from '../src/validate/validate.js';
import { UNIVERSAL_CAPABILITY } from '../src/capabilities.js';
import type { FileRecord } from '../src/scan/types.js';

const files: FileRecord[] = [
  { path: 'README.md', blob_hash: 'sha256:1', size: 1, category: 'doc' },
  { path: 'src/auth/service.ts', blob_hash: 'sha256:2', size: 1, category: 'source' },
  { path: 'src/index.ts', blob_hash: 'sha256:3', size: 1, category: 'source' },
];

describe('buildNodes', () => {
  it('produces a system root node plus one module node per directory', () => {
    const nodes = buildNodes(files, 'demo');
    const kinds = nodes.map((n) => `${n.kind}:${n.slug}`).sort();
    expect(kinds).toEqual(['module:src', 'module:src-auth', 'system:repository']);
  });

  it('scopes root-level files to the system node', () => {
    const root = buildNodes(files, 'demo').find((n) => n.slug === 'repository');
    expect(root?.scope?.files).toEqual(['README.md']);
  });

  it('is deterministic across calls', () => {
    expect(buildNodes(files, 'demo')).toEqual(buildNodes(files, 'demo'));
  });

  it('assembles into a manifest that passes contract validation', () => {
    const nodes = buildNodes(files, 'demo');
    const result = validateManifest({
      schema_version: 1,
      capabilities: [UNIVERSAL_CAPABILITY],
      nodes,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});
