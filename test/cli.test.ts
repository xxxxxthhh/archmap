import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runValidate } from '../src/cli/validate-command.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const fx = (rel: string) => join(fixtures, rel);

describe('runValidate', () => {
  it('exits 0 on a valid manifest', () => {
    const out = runValidate([fx('valid/manifest.yaml')]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('ok');
    expect(out.stderr).toBe('');
  });

  it('exits 1 with errors on stderr for an invalid manifest', () => {
    const out = runValidate([fx('invalid/dangling-relation.yaml')]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('does not reference a known node');
  });

  it('emits a stable JSON report with --json', () => {
    const out = runValidate([fx('invalid/dangling-relation.yaml'), '--json']);
    expect(out.exitCode).toBe(1);
    const report = JSON.parse(out.stdout);
    expect(report.command).toBe('validate');
    expect(report.valid).toBe(false);
    expect(report.errors).toHaveLength(1);
  });

  it('exits 2 on usage error (missing path)', () => {
    const out = runValidate([]);
    expect(out.exitCode).toBe(2);
  });

  it('exits 2 on an unknown/misspelled flag', () => {
    const out = runValidate([fx('valid/manifest.yaml'), '--jso']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unknown option');
  });

  it('exits 2 when the file cannot be read', () => {
    const out = runValidate([fx('valid/does-not-exist.yaml')]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('cannot read manifest file');
  });
});
