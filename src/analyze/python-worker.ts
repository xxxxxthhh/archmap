/** Safe process seam for the packaged native-Python AST worker.
 *
 * Decision: M3 uses a language-native `ast` worker because it is available with Python,
 * parser-authoritative, and adds no native Node dependency. The seam is reversible: model
 * code consumes only the versioned JSON protocol, so a later Tree-sitter implementation can
 * replace the worker without changing fact, evidence, or certainty contracts.
 */

import { existsSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ScanInputError } from '../store-errors.js';

export const PYTHON_ADAPTER_VERSION = '0.2.0';
const PROTOCOL_VERSION = 1;
const MAX_INPUT_BYTES = 7_000_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const WORKER_TIMEOUT_MS = 10_000;

export interface PythonImport {
  kind: 'static';
  level: number;
  module: string;
  names: string[];
}

export interface PythonAnalysis {
  status: 'ok';
  path: string;
  symbols: string[];
  imports: PythonImport[];
  dynamic_imports: string[];
  entry_signals: string[];
  routes: string[];
  cli_commands: string[];
  data_references: PythonDataReference[];
}

export interface PythonDataReference {
  path: string;
  access: 'read' | 'write' | 'bare';
}

export type PythonWorkerState =
  | {
      status: 'available';
      executable: string;
      workerPath: string;
      analyzerVersion: string;
      stdlib: ReadonlySet<string>;
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'invalid'; reason: string };

function configuredWorker(): { executable: string; workerPath: string } {
  return {
    executable: process.env.ARCHMAP_PYTHON?.trim() || 'python3',
    workerPath:
      process.env.ARCHMAP_PYTHON_WORKER?.trim() ||
      fileURLToPath(new URL('../../python/python-worker.py', import.meta.url)),
  };
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function run(executable: string, argv: string[], input?: string) {
  // `-I` ignores PYTHONPATH/user-site state; `-S` prevents ambient site/sitecustomize startup.
  // Keep these flags at the single process seam so probe, analysis, and dependency parsing
  // cannot accidentally diverge in their isolation contract.
  return spawnSync(executable, ['-I', '-S', ...argv], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: WORKER_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
}

function parseObject(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const integerArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

/** Probe both the executable and packaged parser asset without a shell. */
export function probePythonWorker(): PythonWorkerState {
  const { executable, workerPath } = configuredWorker();
  if (!existsSync(workerPath) || !regularFile(workerPath)) {
    return { status: 'unavailable', reason: 'packaged Python worker is unavailable' };
  }
  const result = run(executable, [workerPath, '--probe']);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { status: 'unavailable', reason: 'Python runtime is unavailable' }
      : { status: 'invalid', reason: `Python worker probe failed (${code ?? 'process error'})` };
  }
  if (result.status !== 0) {
    return { status: 'invalid', reason: `Python worker probe exited ${String(result.status)}` };
  }
  const parsed = parseObject(result.stdout);
  if (
    parsed?.protocol_version !== PROTOCOL_VERSION ||
    parsed.status !== 'ok' ||
    !integerArray(parsed.python_version) ||
    parsed.python_version.length < 2 ||
    !stringArray(parsed.stdlib)
  ) {
    return { status: 'invalid', reason: 'Python worker probe returned malformed output' };
  }
  const [major, minor] = parsed.python_version;
  return {
    status: 'available',
    executable,
    workerPath,
    analyzerVersion: `${PYTHON_ADAPTER_VERSION}+python-${major}.${minor}`,
    stdlib: new Set(parsed.stdlib),
  };
}

function validImport(value: unknown): value is PythonImport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === 'static' &&
    Number.isInteger(item.level) &&
    (item.level as number) >= 0 &&
    typeof item.module === 'string' &&
    stringArray(item.names)
  );
}

function validDataReference(value: unknown): value is PythonDataReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.path === 'string' && typeof item.access === 'string' &&
    ['read', 'write', 'bare'].includes(item.access);
}

function parseAnalysis(stdout: string, expectedPath: string): PythonAnalysis | 'syntax-error' | null {
  const parsed = parseObject(stdout);
  if (parsed?.protocol_version !== PROTOCOL_VERSION || parsed.path !== expectedPath) return null;
  if (parsed.status === 'syntax-error') return 'syntax-error';
  if (
    parsed.status !== 'ok' ||
    !stringArray(parsed.symbols) ||
    !Array.isArray(parsed.imports) ||
    !parsed.imports.every(validImport) ||
    !stringArray(parsed.dynamic_imports) ||
    !stringArray(parsed.entry_signals) ||
    !stringArray(parsed.routes) ||
    !stringArray(parsed.cli_commands) ||
    !Array.isArray(parsed.data_references) ||
    !parsed.data_references.every(validDataReference)
  ) {
    return null;
  }
  return parsed as unknown as PythonAnalysis;
}

/** Analyze exactly one bounded file. Any protocol/process failure aborts the scan before writes. */
export function analyzeWithPythonWorker(
  runtime: Extract<PythonWorkerState, { status: 'available' }>,
  path: string,
  source: Buffer,
): PythonAnalysis | null {
  const input = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    path,
    source_base64: source.toString('base64'),
  });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new ScanInputError(`Python worker input exceeds ${MAX_INPUT_BYTES} bytes for ${path}`);
  }
  const result = run(runtime.executable, [runtime.workerPath], input);
  if (result.error || result.status !== 0) {
    throw new ScanInputError(`Python worker failed while analyzing ${path}`);
  }
  const parsed = parseAnalysis(result.stdout, path);
  if (parsed === null) throw new ScanInputError(`Python worker returned malformed output for ${path}`);
  return parsed === 'syntax-error' ? null : parsed;
}

/** Parse Python packaging metadata inside the same bounded native worker. */
export function declaredPythonDependencies(
  runtime: Extract<PythonWorkerState, { status: 'available' }>,
  pyproject: string,
  requirements: string,
): ReadonlySet<string> {
  const input = JSON.stringify({ protocol_version: PROTOCOL_VERSION, pyproject, requirements });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new ScanInputError('Python dependency metadata exceeds the worker input bound');
  }
  const result = run(runtime.executable, [runtime.workerPath, '--dependencies'], input);
  if (result.error || result.status !== 0) {
    throw new ScanInputError('Python worker failed while parsing dependency metadata');
  }
  const parsed = parseObject(result.stdout);
  if (
    parsed?.protocol_version !== PROTOCOL_VERSION ||
    parsed.status !== 'ok' ||
    !stringArray(parsed.dependencies)
  ) {
    throw new ScanInputError('Python worker returned malformed dependency metadata');
  }
  return new Set(parsed.dependencies);
}
