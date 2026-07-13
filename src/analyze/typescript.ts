/**
 * TypeScript/JavaScript syntactic analysis (PLAN 7.1, 11).
 *
 * Uses the TypeScript compiler's single-file parser (`ts.createSourceFile`) — syntactic only,
 * no type resolution — so extraction is deterministic and fast. Reliable, syntactic outputs
 * (imports, exports, entry-point signals) are returned plainly; heuristic detections (routes,
 * HTTP calls, CLI commands) are returned separately so the model can mark them `partial`.
 */

import _ts from 'typescript';
import { TS_JS_EXTENSIONS } from './languages.js';

// typescript ships as CJS with `export =`; this keeps the namespace usable under
// verbatimModuleSyntax + NodeNext.
const ts = _ts as unknown as typeof import('typescript');

/** A heuristic route exposed by a module, e.g. `GET /users`. */
export interface RouteHit {
  method: string;
  path: string;
}

/** Deterministic analysis of one source file. All lists are de-duplicated and sorted. */
export interface ModuleAnalysis {
  /** Exported symbol names. */
  exports: string[];
  /** Distinct import module specifiers, as written in source. */
  imports: string[];
  /** Non-heuristic entry-point signals (currently: `shebang`). */
  entrySignals: string[];
  /** Heuristic: express-style routes. */
  routes: RouteHit[];
  /** Heuristic: external HTTP call markers (e.g. `fetch`, `axios`). */
  httpCalls: string[];
  /** Heuristic: CLI command names registered via `.command('name')`. */
  cliCommands: string[];
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);

function scriptKind(path: string): _ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const sortUnique = (xs: string[]): string[] => [...new Set(xs)].sort();

function stringLiteral(node: _ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Analyze one TS/JS file's source text. */
export function analyzeSource(path: string, text: string): ModuleAnalysis {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));

  const exports: string[] = [];
  const imports: string[] = [];
  const routes: RouteHit[] = [];
  const httpCalls: string[] = [];
  const cliCommands: string[] = [];

  const addImport = (spec: string | undefined): void => {
    if (spec) imports.push(spec);
  };

  const modifiersOf = (node: _ts.Node): readonly _ts.ModifierLike[] =>
    ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const hasExportModifier = (node: _ts.Node): boolean =>
    modifiersOf(node).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: _ts.Node): void => {
    // --- imports (reliable) ---
    if (ts.isImportDeclaration(node)) {
      addImport(stringLiteral(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addImport(stringLiteral(node.moduleSpecifier)); // re-export is also an import edge
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword // dynamic import('x')
    ) {
      addImport(stringLiteral(node.arguments[0]));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      addImport(stringLiteral(node.arguments[0]));
    }

    // --- exports (reliable) ---
    if (ts.isExportAssignment(node)) {
      exports.push(node.isExportEquals ? 'export=' : 'default');
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) exports.push(el.name.text);
    } else if (hasExportModifier(node)) {
      const isDefault = modifiersOf(node).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name
      ) {
        exports.push(node.name.text);
      } else if (
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        exports.push(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exports.push(decl.name.text);
        }
      } else if (isDefault) {
        exports.push('default');
      }
    }

    // --- heuristics ---
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toLowerCase();
      const firstArg = stringLiteral(node.arguments[0]);
      if (HTTP_METHODS.has(method) && firstArg && firstArg.startsWith('/')) {
        routes.push({ method: method.toUpperCase(), path: firstArg });
      }
      if (node.expression.name.text === 'command' && firstArg) {
        cliCommands.push(firstArg.split(/\s+/)[0] ?? firstArg);
      }
      // axios.get(...) / axios.post(...)
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'axios') {
        httpCalls.push('axios');
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'fetch') httpCalls.push('fetch');
      if (node.expression.text === 'axios') httpCalls.push('axios');
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  const entrySignals: string[] = [];
  if (text.startsWith('#!')) entrySignals.push('shebang');

  return {
    exports: sortUnique(exports),
    imports: sortUnique(imports),
    entrySignals,
    routes: dedupeRoutes(routes),
    httpCalls: sortUnique(httpCalls),
    cliCommands: sortUnique(cliCommands),
  };
}

function dedupeRoutes(routes: RouteHit[]): RouteHit[] {
  const seen = new Map<string, RouteHit>();
  for (const r of routes) seen.set(`${r.method} ${r.path}`, r);
  return [...seen.values()].sort((a, b) =>
    `${a.method} ${a.path}` < `${b.method} ${b.path}` ? -1 : 1,
  );
}

export { TS_JS_EXTENSIONS };
