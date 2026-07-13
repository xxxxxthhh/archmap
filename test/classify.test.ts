import { describe, it, expect } from 'vitest';
import { classify } from '../src/scan/classify.js';

describe('classify', () => {
  it('detects manifests (specific names beat generic config)', () => {
    expect(classify('package.json')).toBe('manifest');
    expect(classify('frontend/package.json')).toBe('manifest');
    expect(classify('pyproject.toml')).toBe('manifest');
    expect(classify('requirements-dev.txt')).toBe('manifest');
    expect(classify('go.mod')).toBe('manifest');
  });

  it('detects docs by extension and by conventional stem', () => {
    expect(classify('docs/guide.md')).toBe('doc');
    expect(classify('README')).toBe('doc');
    expect(classify('LICENSE')).toBe('doc');
  });

  it('detects config files', () => {
    expect(classify('tsconfig.json')).toBe('config');
    expect(classify('.editorconfig')).toBe('config');
    expect(classify('config/app.yaml')).toBe('config');
  });

  it('detects source files', () => {
    expect(classify('src/index.ts')).toBe('source');
    expect(classify('main.py')).toBe('source');
    expect(classify('lib/mod.rs')).toBe('source');
  });

  it('falls back to other', () => {
    expect(classify('data/blob')).toBe('other');
    expect(classify('image.unknownext')).toBe('other');
  });

  it('is a pure function of the path', () => {
    expect(classify('src/index.ts')).toBe(classify('src/index.ts'));
  });
});
