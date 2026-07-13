import { describe, it, expect } from 'vitest';
import { buildExclusionRules, excludeByName } from '../src/scan/exclude.js';

const rules = (secret_globs: string[]) =>
  buildExclusionRules({ exclude_dirs: [], secret_globs, max_file_bytes: 1000 });

describe('secret glob matching', () => {
  it('never throws on regex-metacharacter globs and matches them literally', () => {
    for (const g of ['?', '[', '\\', '+', '(', ')', 'a?b', '[abc]']) {
      expect(() => rules([g])).not.toThrow();
    }
    // `?` is a literal, not a wildcard.
    expect(excludeByName('?', rules(['?']))).toBe('secret');
    expect(excludeByName('x', rules(['?']))).toBe(null);
    expect(excludeByName('a?b', rules(['a?b']))).toBe('secret');
    expect(excludeByName('ab', rules(['a?b']))).toBe(null);
    // `[abc]` matches the literal 5-character name, not a character class.
    expect(excludeByName('[abc]', rules(['[abc]']))).toBe('secret');
    expect(excludeByName('a', rules(['[abc]']))).toBe(null);
  });

  it('treats * as a wildcard', () => {
    expect(excludeByName('secret.pem', rules(['*.pem']))).toBe('secret');
    expect(excludeByName('deep/dir/key.pem', rules(['*.pem']))).toBe('secret');
    expect(excludeByName('key.txt', rules(['*.pem']))).toBe(null);
    expect(excludeByName('anything', rules(['*']))).toBe('secret');
  });
});
