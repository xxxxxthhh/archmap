import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadView, validateViewDocument } from '../src/views/load.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'viewer-repo');

describe('validateViewDocument', () => {
  it('accepts a minimal versioned view', () => {
    const r = validateViewDocument({ schema_version: 1, id: 'overall' }, 'overall');
    expect(r.ok).toBe(true);
  });

  it('accepts the full allowlist', () => {
    const r = validateViewDocument(
      {
        schema_version: 1,
        id: 'full',
        include: {
          node_kinds: ['system', 'component'],
          edge_types: ['calls', 'reads'],
          path_prefixes: ['src/api/', 'README.md'],
        },
        collapse_below: 'component',
        layout: 'top-to-bottom',
      },
      'full',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an unversioned view', () => {
    const r = validateViewDocument({ id: 'x' }, 'x');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('schema_version') });
  });

  it('rejects an unsupported schema_version without touching the v1 schema', () => {
    const r = validateViewDocument({ schema_version: 2, id: 'x' }, 'x');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('unsupported view schema_version 2') });
  });

  it('fails closed on any key outside the allowlist (no source content, evidence, or proposal data)', () => {
    for (const extra of ['evidence', 'source', 'operations', 'claims']) {
      const r = validateViewDocument({ schema_version: 1, id: 'x', [extra]: 'leak' }, 'x');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(extra);
    }
  });

  it('rejects an unknown node kind or edge type', () => {
    expect(validateViewDocument({ schema_version: 1, id: 'x', include: { node_kinds: ['db'] } }, 'x').ok).toBe(false);
    expect(validateViewDocument({ schema_version: 1, id: 'x', include: { edge_types: ['owns'] } }, 'x').ok).toBe(false);
  });

  it('rejects unsafe or non-canonical path prefixes', () => {
    for (const prefix of ['', '/src', 'C:/src', '.', '..', './src', 'src/./api', 'src/../api', 'src\\api', 'src//api', 'src\0api']) {
      const r = validateViewDocument(
        { schema_version: 1, id: 'x', include: { path_prefixes: [prefix] } },
        'x',
      );
      expect(r.ok, JSON.stringify(prefix)).toBe(false);
    }
  });

  it('rejects an empty path-prefix list', () => {
    expect(validateViewDocument({ schema_version: 1, id: 'x', include: { path_prefixes: [] } }, 'x').ok).toBe(false);
  });

  it('rejects a collapse_below outside the structural hierarchy', () => {
    expect(validateViewDocument({ schema_version: 1, id: 'x', collapse_below: 'external' }, 'x').ok).toBe(false);
  });

  it('rejects a file whose id does not match the requested view', () => {
    const r = validateViewDocument({ schema_version: 1, id: 'other' }, 'requested');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('does not match') });
  });
});

describe('loadView (filesystem + security)', () => {
  it('loads the tracked fixture views', () => {
    const overall = loadView(FIXTURE, 'overall');
    expect(overall.ok).toBe(true);
    const collapsed = loadView(FIXTURE, 'collapsed');
    expect(collapsed.ok && collapsed.view.collapse_below).toBe('component');
  });

  it('rejects a path-escaping view id before any filesystem access', () => {
    for (const id of ['../secret', '..', 'a/b', '/etc/passwd', 'Overall']) {
      const r = loadView(FIXTURE, id);
      expect(r).toEqual({ ok: false, error: expect.stringContaining('invalid view id') });
    }
  });

  it('reports a missing view without escaping the view directory', () => {
    expect(loadView(FIXTURE, 'does-not-exist')).toEqual({ ok: false, error: 'view not found' });
  });

  describe('with a scratch project', () => {
    let root: string;
    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-views-')));
      mkdirSync(join(root, '.archmap', 'views'), { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('fails closed on a malformed view file', () => {
      writeFileSync(join(root, '.archmap', 'views', 'bad.yaml'), 'schema_version: 1\nid: bad\nevidence: leak\n');
      const r = loadView(root, 'bad');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('evidence');
    });

    it('fails closed on non-YAML content', () => {
      writeFileSync(join(root, '.archmap', 'views', 'junk.yaml'), ':\n  - [unbalanced\n');
      expect(loadView(root, 'junk').ok).toBe(false);
    });

    it('refuses to follow a symlinked view file', () => {
      symlinkSync('/etc/passwd', join(root, '.archmap', 'views', 'evil.yaml'));
      expect(loadView(root, 'evil')).toEqual({ ok: false, error: expect.stringContaining('symlink') });
    });
  });
});
