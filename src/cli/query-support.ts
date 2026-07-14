/** Shared plumbing for the read-only query commands (`context`, `impact`, `evidence`). */

import { loadTrackedProject } from '../query/project.js';
import type { TrackedBaseline } from '../scan/baseline.js';
import { usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

type Loaded =
  | { ok: true; root: string; baseline: TrackedBaseline }
  | { ok: false; out: CommandOutput };

/**
 * CLI adapter over the shared validated read path: any store/validation error (including an
 * unscanned project) becomes a stable exit-2 result — the query commands never operate on an
 * unvalidated or absent model.
 */
export function loadScannedProject(ctx: CommandContext, json: boolean): Loaded {
  const loaded = loadTrackedProject(ctx.cwd);
  if (!loaded.ok) return { ok: false, out: usageError(json, loaded.error) };
  return { ok: true, root: loaded.root, baseline: loaded.baseline };
}

export { toRepoPaths } from '../query/project.js';
