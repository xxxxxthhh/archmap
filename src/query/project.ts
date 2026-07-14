/**
 * The single validated entry point every read-only query surface (CLI and MCP) uses to reach
 * the tracked model. Each call re-reads and re-validates the baseline, so a caller can never
 * answer from a process-stale model, and an unscanned/incomplete/invalid project always fails
 * closed with one shared message taxonomy instead of a partial result.
 */

import { relative, resolve, sep } from 'node:path';
import { readTrackedBaseline, type TrackedBaseline } from '../scan/baseline.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';

export type LoadedProject =
  | { ok: true; root: string; baseline: TrackedBaseline }
  | { ok: false; error: string };

/** Resolve the project root and read + validate the tracked baseline. */
export function loadTrackedProject(cwd: string): LoadedProject {
  try {
    const root = resolveProjectRoot(cwd);
    if (!root) return { ok: false, error: 'not an archmap project; run `archmap init` first' };
    const baseline = readTrackedBaseline(root);
    if (!baseline) return { ok: false, error: 'not scanned yet; run `archmap scan` first' };
    return { ok: true, root, baseline };
  } catch (err) {
    if (err instanceof StoreError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Normalize path arguments (relative to `cwd`) to repository-relative, POSIX-style paths. */
export function toRepoPaths(root: string, cwd: string, args: string[]): string[] {
  return args.map((a) => relative(root, resolve(cwd, a)).split(sep).join('/'));
}
