import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readTrackedBaseline } from '../src/scan/baseline.js';
import { projectModel } from '../src/render/project.js';
import { renderGraph, type ExportFormat } from '../src/render/index.js';
import { loadView } from '../src/views/load.js';
import { toCanonicalJson } from '../src/model/canonical.js';
import type { Node } from '../src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'viewer-repo');
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function nodes() {
  const baseline = readTrackedBaseline(FIXTURE);
  if (!baseline) throw new Error('viewer-repo fixture is not scanned');
  return baseline.nodes;
}

function render(viewId: string, format: ExportFormat): string {
  const vr = loadView(FIXTURE, viewId);
  if (!vr.ok) throw new Error(vr.error);
  return renderGraph(format, projectModel(nodes(), vr.view));
}

function golden(viewId: string, ext: string): string {
  return readFileSync(join(FIXTURE, 'exports', `${viewId}.${ext}`), 'utf8');
}

const CASES: Array<[string, ExportFormat, string]> = [
  ['overall', 'mermaid', 'mermaid'],
  ['overall', 'markdown', 'md'],
  ['overall', 'svg', 'svg'],
  ['collapsed', 'mermaid', 'mermaid'],
  ['collapsed', 'markdown', 'md'],
  ['collapsed', 'svg', 'svg'],
];

describe('export goldens', () => {
  for (const [viewId, format, ext] of CASES) {
    it(`${viewId}/${format} matches its canonical golden`, () => {
      expect(render(viewId, format)).toBe(golden(viewId, ext));
    });

    it(`${viewId}/${format} is byte-identical across two fresh renders`, () => {
      expect(render(viewId, format)).toBe(render(viewId, format));
    });
  }

  it('collapsed goldens show fewer nodes than the normal graph in every format', () => {
    expect(golden('collapsed', 'mermaid')).toContain('nodes 5/7 (collapsed 2)');
    expect(golden('overall', 'mermaid')).toContain('nodes 7/7 (collapsed 0)');
    expect(golden('collapsed', 'md')).toContain('Nodes 5/7 (collapsed 2)');
    expect(golden('collapsed', 'svg')).toContain('nodes 5/7');
  });
});

describe('format distinctions (no false promotion)', () => {
  it('mermaid draws known solid and partial/unknown dotted with distinct markers', () => {
    const m = render('overall', 'mermaid');
    expect(m).toContain('-->|reads| node_db'); // known: solid
    expect(m).toContain('-.->|calls ~| node_payments'); // partial: dotted
    expect(m).toContain('-.->|consumes ?| node_payments'); // unknown: dotted
    expect(m).toContain('component · fact 1 · inf 1'); // fact vs inference visible
    expect(m).toContain('stale 1'); // stale visible
  });

  it('markdown spells out certainty and claim type/status/actor', () => {
    const md = render('overall', 'markdown');
    expect(md).toContain('certainty: known');
    expect(md).toContain('certainty: partial');
    expect(md).toContain('certainty: unknown');
    expect(md).toContain('[fact] (analyzer)');
    expect(md).toContain('[inference] (agent)');
    expect(md).toContain('[inference, stale] (human)');
  });

  it('svg styles known solid and partial/unknown dashed/dotted, and marks stale nodes', () => {
    const svg = render('overall', 'svg');
    expect(svg).toContain('stroke="#555" stroke-width="1.5" />'); // known: solid, no dash
    expect(svg).toContain('stroke-dasharray="6 4"'); // partial: dashed
    expect(svg).toContain('stroke-dasharray="2 5"'); // unknown: dotted
    expect(svg).toContain('stroke="#b45309"'); // stale node border
  });
});

describe('content safety: untrusted titles and claim bodies never emit active payloads', () => {
  const EVIL_TITLE = '<img src="https://example.invalid/title-pixel">';
  const EVIL_CLAIM = '![remote](https://example.invalid/claim-pixel) <script>boom()</script>';
  const EVIL_PATH = '<script>evil</script>/x.ts';

  const evilNodes: Node[] = [
    { id: 'node_cdb4ee2aea69cc6a', slug: 'repository', kind: 'system', title: 'Root', claims: [], relations: [] },
    {
      id: 'node_evil',
      slug: 'evil',
      kind: 'component',
      title: EVIL_TITLE,
      claims: [
        {
          id: 'claim_evil',
          type: 'inference',
          text: EVIL_CLAIM,
          status: 'active',
          confidence: 0.5,
          provenance: { actor: 'human', created_at: '2026-07-13T00:00:00Z' },
          evidence: [
            {
              repository: 'r',
              commit: 'c',
              path: EVIL_PATH,
              analyzer: 'typescript',
              analyzer_version: '0.1.0',
              blob_hash: 'sha256:x',
              extract_hash: 'sha256:y',
            },
          ],
        },
      ],
      relations: [],
    },
  ];

  const graph = projectModel(evilNodes, { schema_version: 1, id: 'default' });

  // Active constructs that must never survive into any export or the JSON projection. The
  // remote URL is asserted with its scheme so a legitimate SVG namespace URI is not a false hit;
  // neutralization breaks `https://` so the resource can neither auto-link nor be fetched.
  const ACTIVE_TOKENS = ['<script', '<img', '](', '![', 'https://example.invalid', 'src="'];

  function assertInert(label: string, out: string): void {
    for (const token of ACTIVE_TOKENS) {
      expect(out, `${label} retained active token ${JSON.stringify(token)}`).not.toContain(token);
    }
    expect(out, `${label} retained the raw title payload`).not.toContain(EVIL_TITLE);
    expect(out, `${label} retained the raw claim payload`).not.toContain(EVIL_CLAIM);
    expect(out, `${label} retained the raw evidence-path payload`).not.toContain(EVIL_PATH);
  }

  it('neutralizes every format and the JSON projection', () => {
    assertInert('markdown', renderGraph('markdown', graph));
    assertInert('mermaid', renderGraph('mermaid', graph));
    assertInert('svg', renderGraph('svg', graph));
    assertInert('json', toCanonicalJson({ projection: graph }));
  });

  it('preserves the contract fields alongside neutralized text', () => {
    const evil = graph.nodes.find((n) => n.id === 'node_evil')!;
    expect(evil.kind).toBe('component'); // stable id + kind preserved
    expect(evil.title.length).toBeGreaterThan(0); // neutralized, not dropped
    expect(evil.claims[0]).toMatchObject({ id: 'claim_evil', type: 'inference', status: 'active', actor: 'human' });
    // Evidence still points at a (neutralized) location and carries its hash.
    expect(evil.claims[0]!.evidence[0]!.blob_hash).toBe('sha256:x');
    // Markdown still distinguishes inference and spells out the (neutralized) claim.
    expect(renderGraph('markdown', graph)).toContain('[inference] (human)');
  });
});

describe('archmap export (compiled-source bin probe)', () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ['--import', TSX_IMPORT, BIN, ...args], {
      cwd: FIXTURE,
      encoding: 'utf8',
    });
  }

  // Starts three real tsx source-bin processes; give it headroom over Vitest's 5s default so it
  // stays green under concurrent full-suite load (isolated it runs in ~4s).
  it('renders each format to stdout with exit 0 and no stderr', () => {
    for (const [, format] of CASES) {
      const res = run(['export', '--format', format, '--view', 'overall']);
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
      expect(res.stdout.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('produces byte-identical output across two process runs', () => {
    const a = run(['export', '--format', 'svg', '--view', 'collapsed']);
    const b = run(['export', '--format', 'svg', '--view', 'collapsed']);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toBe(golden('collapsed', 'svg'));
  });

  it('emits a schema-versioned canonical JSON envelope with --json', () => {
    const res = run(['export', '--format', 'mermaid', '--view', 'overall', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toMatchObject({ schema_version: 1, command: 'export', format: 'mermaid' });
    expect(parsed.projection.stats.visible_nodes).toBe(7);
    expect(parsed.output).toBe(golden('overall', 'mermaid'));
    // Canonical: two runs identical, keys sorted.
    expect(run(['export', '--format', 'mermaid', '--view', 'overall', '--json']).stdout).toBe(res.stdout);
  });

  it('fails closed (exit 2, empty stdout) on a path-escaping view', () => {
    const res = run(['export', '--format', 'svg', '--view', '../../etc/passwd']);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('invalid view id');
  });

  it('fails closed (exit 2, empty stdout) on a missing format', () => {
    const res = run(['export']);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--format');
  });

  it('fails closed (exit 2, empty stdout) on an unscanned project', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-export-')));
    try {
      const res = spawnSync(process.execPath, ['--import', TSX_IMPORT, BIN, 'export', '--format', 'svg'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
