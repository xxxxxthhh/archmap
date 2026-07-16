import { describe, expect, it } from 'vitest';
import { evaluateCheck } from '../src/check/evaluate.js';
import { compareCodeUnits, toCanonicalJson } from '../src/model/canonical.js';
import type { Node } from '../src/model/types.js';
import type { StatusResult } from '../src/scan/status.js';
import type { DisallowRule } from '../src/check/types.js';
import { matchesPathGlob } from '../src/check/rules.js';

describe('M7 deterministic check primitives', () => {
  it('orders public composite keys by UTF-16 code units without locale behavior', () => {
    const values = ['é', 'a\u0000z', 'aa', 'A', 'a\u0000a', 'a'];

    expect([...values].sort(compareCodeUnits)).toEqual([
      'A',
      'a',
      'a\u0000a',
      'a\u0000z',
      'aa',
      'é',
    ]);
    expect(compareCodeUnits('a\u0000a', 'a\u0000z')).toBeLessThan(0);
    expect(compareCodeUnits('a', 'a\u0000a')).toBeLessThan(0);
  });

  it('uses code-unit order for public violations and matched paths', () => {
    const source = (id: string, path: string): Node => ({
      id,
      slug: id,
      kind: 'module',
      title: id,
      scope: { files: [path] },
      claims: [],
      relations: [{ id: `rel-${id}`, type: 'imports', target: 'target', certainty: 'known' }],
    });
    const target: Node = {
      id: 'target',
      slug: 'target',
      kind: 'module',
      title: 'target',
      scope: { files: ['target/value.ts'] },
      claims: [],
      relations: [],
    };
    const status: StatusResult = {
      scanned: true,
      clean: true,
      base_commit: 'base',
      dirty: false,
      diff: null,
      drift: [],
      stale_nodes: [],
      file_count: 4,
      node_count: 4,
    };
    const rule: DisallowRule = {
      schema_version: 1,
      id: 'ordering',
      severity: 'warning',
      from: { path: 'src/**' },
      disallow: { edge_type: 'imports', target: { path: 'target/**' } },
    };

    const nodes = [source('é', 'src/é.ts'), source('a', 'src/a.ts'), source('A', 'src/A.ts'), target];
    const report = evaluateCheck(nodes, status, [rule], false);
    const reversed = evaluateCheck([...nodes].reverse(), status, [rule], false);

    expect(report.violations.map((violation) => violation.kind === 'rule' && violation.source_node_id)).toEqual([
      'A',
      'a',
      'é',
    ]);
    expect(toCanonicalJson(reversed)).toBe(toCanonicalJson(report));
  });

  it('uses code-unit order when choosing the public matching paths', () => {
    const source: Node = {
      id: 'source',
      slug: 'source',
      kind: 'module',
      title: 'source',
      scope: { files: ['src/é.ts', 'src/a.ts', 'src/A.ts'] },
      claims: [],
      relations: [{ id: 'rel-source', type: 'imports', target: 'target', certainty: 'known' }],
    };
    const target: Node = {
      id: 'target',
      slug: 'target',
      kind: 'module',
      title: 'target',
      scope: { files: ['target/é.ts', 'target/a.ts', 'target/A.ts'] },
      claims: [],
      relations: [],
    };
    const status: StatusResult = {
      scanned: true,
      clean: true,
      base_commit: 'base',
      dirty: false,
      diff: null,
      drift: [],
      stale_nodes: [],
      file_count: 6,
      node_count: 2,
    };
    const rule: DisallowRule = {
      schema_version: 1,
      id: 'paths',
      severity: 'warning',
      from: { path: 'src/**' },
      disallow: { edge_type: 'imports', target: { path: 'target/**' } },
    };

    const violation = evaluateCheck([source, target], status, [rule], false).violations[0];
    expect(violation).toMatchObject({
      kind: 'rule',
      source_path: 'src/A.ts',
      target_path: 'target/A.ts',
    });
  });

  it.each([
    ['src/*.ts', 'src/panel.ts', true],
    ['src/*.ts', 'src/ui/panel.ts', false],
    ['src/a*bc.ts', 'src/abbbc.ts', true],
    ['src/a*bc.ts', 'src/abc.ts', true],
    ['src/a*bc.ts', 'src/ac.ts', false],
    ['src/panel*', 'src/panel', true],
    ['src/panel*', 'src/panel.ts', true],
    ['src/**/panel.ts', 'src/panel.ts', true],
    ['src/**/panel.ts', 'src/ui/panel.ts', true],
    ['src/ui/**', 'src/ui', true],
    ['src/ui/**', 'src/ui/panel.ts', true],
    ['**', 'src/ui/panel.ts', true],
  ])('matches %s against %s as %s', (pattern, path, expected) => {
    expect(matchesPathGlob(pattern, path)).toBe(expected);
  });
});
