import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadManifestFile } from '../src/validate/load.js';
import { validateManifest } from '../src/validate/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function validateFixture(rel: string) {
  return validateManifest(loadManifestFile(join(fixtures, rel)));
}

describe('validateManifest', () => {
  it('accepts the valid fixture', () => {
    const result = validateFixture('valid/manifest.yaml');
    expect(result).toEqual({ valid: true, errors: [] });
  });

  const invalidCases: Array<{ file: string; pathFragment: string; messageFragment: string }> = [
    {
      file: 'invalid/missing-evidence.yaml',
      pathFragment: '/nodes/0/claims/0/evidence',
      messageFragment: 'fewer than 1 items',
    },
    {
      file: 'invalid/dangling-relation.yaml',
      pathFragment: '/nodes/0/relations/0/target',
      messageFragment: 'does not reference a known node',
    },
    {
      file: 'invalid/bad-schema-version.yaml',
      pathFragment: '/schema_version',
      messageFragment: 'unsupported schema_version 2',
    },
    {
      file: 'invalid/known-relation-without-evidence.yaml',
      pathFragment: '/nodes/0/relations/0/evidence',
      messageFragment: 'requires at least one evidence entry',
    },
    {
      file: 'invalid/duplicate-id.yaml',
      pathFragment: '/nodes/1/id',
      messageFragment: 'duplicate id',
    },
    {
      file: 'invalid/fact-from-non-analyzer.yaml',
      pathFragment: '/nodes/0/claims/0/provenance/actor',
      messageFragment: 'fact claims must be produced by an analyzer',
    },
    {
      file: 'invalid/model-without-agent.yaml',
      pathFragment: '/nodes/0/claims/0/provenance/model',
      messageFragment: 'may only be set when actor is "agent"',
    },
    {
      file: 'invalid/evidence-unknown-analyzer.yaml',
      pathFragment: '/nodes/0/claims/0/evidence/0',
      messageFragment: 'is not a declared capability',
    },
    {
      file: 'invalid/fact-from-partial-capability.yaml',
      pathFragment: '/nodes/0/claims/0/evidence/0',
      messageFragment: 'deterministic evidence requires a supported capability',
    },
    {
      file: 'invalid/known-relation-partial-capability.yaml',
      pathFragment: '/nodes/0/relations/0/evidence/0',
      messageFragment: 'deterministic evidence requires a supported capability',
    },
    {
      file: 'invalid/duplicate-capability.yaml',
      pathFragment: '/capabilities/1',
      messageFragment: 'duplicate capability "typescript@0.1.0"',
    },
  ];

  for (const { file, pathFragment, messageFragment } of invalidCases) {
    it(`rejects ${file}`, () => {
      const result = validateFixture(file);
      expect(result.valid).toBe(false);
      // Each invalid fixture carries exactly one defect, so it must fail for that reason
      // alone — no incidental errors masking or padding the intended rule.
      expect(result.errors, JSON.stringify(result.errors)).toHaveLength(1);
      const [error] = result.errors;
      expect(error?.path).toBe(pathFragment);
      expect(error?.message).toContain(messageFragment);
    });
  }

  it('rejects a non-object input without throwing', () => {
    const result = validateManifest(42);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
