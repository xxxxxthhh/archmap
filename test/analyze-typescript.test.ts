import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../src/analyze/typescript.js';

describe('analyzeSource', () => {
  it('extracts import specifiers (import, re-export, require, dynamic)', () => {
    const a = analyzeSource(
      'm.ts',
      [
        "import { x } from './rel.js';",
        "import def from 'pkg';",
        "export { y } from './reexport.js';",
        "const z = require('cjs-pkg');",
        "async function f() { await import('dyn'); }",
      ].join('\n'),
    );
    expect(a.imports).toEqual(['./reexport.js', './rel.js', 'cjs-pkg', 'dyn', 'pkg']);
  });

  it('extracts exported symbol names of every declaration form', () => {
    const a = analyzeSource(
      'm.ts',
      [
        'export const a = 1;',
        'export function b() {}',
        'export class C {}',
        'export interface I {}',
        'export type T = string;',
        'export enum E { A }',
        'export default 5;',
      ].join('\n'),
    );
    expect(a.exports).toEqual(['C', 'E', 'I', 'T', 'a', 'b', 'default']);
  });

  it('detects a shebang entry signal', () => {
    expect(analyzeSource('bin.ts', '#!/usr/bin/env node\nconsole.log(1);\n').entrySignals).toEqual(['shebang']);
    expect(analyzeSource('bin.ts', 'console.log(1);\n').entrySignals).toEqual([]);
  });

  it('detects express-style routes, http calls, and cli commands (heuristics)', () => {
    const a = analyzeSource(
      'm.ts',
      [
        "app.get('/health', () => {});",
        "router.post('/users', () => {});",
        "fetch('https://x');",
        "axios.get('https://y');",
        "program.command('start');",
      ].join('\n'),
    );
    expect(a.routes).toEqual([
      { method: 'GET', path: '/health' },
      { method: 'POST', path: '/users' },
    ]);
    expect(a.httpCalls).toEqual(['axios', 'fetch']);
    expect(a.cliCommands).toEqual(['start']);
  });

  it('does not treat a non-slash first argument as a route', () => {
    expect(analyzeSource('m.ts', "obj.get('name');").routes).toEqual([]);
  });

  it('is deterministic (sorted, de-duplicated)', () => {
    const src = "import 'b';\nimport 'a';\nimport 'a';\nexport const z=1;\nexport const a=2;";
    expect(analyzeSource('m.ts', src)).toEqual(analyzeSource('m.ts', src));
    expect(analyzeSource('m.ts', src).imports).toEqual(['a', 'b']);
  });
});
