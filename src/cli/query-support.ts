/** Shared plumbing for the read-only query commands (`context`, `impact`, `evidence`). */

import { relative, resolve, sep } from 'node:path';
import { readTrackedBaseline, type TrackedBaseline } from '../scan/baseline.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';
import { usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

type Loaded =
  | { ok: true; root: string; baseline: TrackedBaseline }
  | { ok: false; out: CommandOutput };

/**
 * Resolve the project root and read + validate the tracked baseline. Any store/validation
 * error (including an unscanned project) becomes a stable exit-2 result — the query commands
 * never operate on an unvalidated or absent model.
 */
export function loadScannedProject(ctx: CommandContext, json: boolean): Loaded {
  try {
    const root = resolveProjectRoot(ctx.cwd);
    if (!root) return { ok: false, out: usageError(json, 'not an archmap project; run `archmap init` first') };
    const baseline = readTrackedBaseline(root);
    if (!baseline) return { ok: false, out: usageError(json, 'not scanned yet; run `archmap scan` first') };
    return { ok: true, root, baseline };
  } catch (err) {
    if (err instanceof StoreError) return { ok: false, out: usageError(json, err.message) };
    throw err;
  }
}

/** Normalize CLI path arguments (relative to cwd) to repository-relative, POSIX-style paths. */
export function toRepoPaths(root: string, cwd: string, args: string[]): string[] {
  return args.map((a) => relative(root, resolve(cwd, a)).split(sep).join('/'));
}
