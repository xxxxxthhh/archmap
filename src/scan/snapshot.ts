/** Snapshot construction and diffing — the basis of stale detection (PLAN 12, M1). */

import { getAdapterRegistry } from '../capabilities.js';
import type { Capability } from '../model/types.js';
import type { Discovery, FileRecord, Snapshot, SnapshotDiff } from './types.js';

/**
 * Capabilities declared in every snapshot. Both adapters ship in this build; declaring them
 * (id + version) lets M0 validation confirm that analyzer facts/relations cite a supported
 * capability. Order is fixed for determinism.
 */
export const DECLARED_CAPABILITIES = getAdapterRegistry();

/** Assemble the deterministic snapshot written by `scan`. */
export function buildSnapshot(
  discovery: Discovery,
  capabilities: readonly Capability[] = getAdapterRegistry(),
): Snapshot {
  return {
    schema_version: 1,
    base_commit: discovery.base_commit,
    dirty: discovery.dirty,
    capabilities: [...capabilities],
    files: discovery.files,
    excluded_counts: discovery.excluded_counts,
  };
}

/**
 * Diff a previous snapshot against the currently discovered files. A path present on both
 * sides with a changed hash is `modified`; a delete + add sharing a blob hash is reported as
 * a `rename` rather than a spurious delete/add pair.
 */
export function diffSnapshot(previous: FileRecord[], current: FileRecord[]): SnapshotDiff {
  const prev = new Map(previous.map((f) => [f.path, f]));
  const curr = new Map(current.map((f) => [f.path, f]));

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;

  for (const [path, file] of curr) {
    const before = prev.get(path);
    if (!before) {
      added.push(path);
    } else if (before.blob_hash !== file.blob_hash) {
      modified.push(path);
    } else {
      unchanged += 1;
    }
  }
  for (const path of prev.keys()) {
    if (!curr.has(path)) deleted.push(path);
  }

  const renamed = extractRenames(added, deleted, prev, curr);

  added.sort();
  modified.sort();
  deleted.sort();
  renamed.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  return { added, modified, deleted, renamed, unchanged };
}

/**
 * Pull rename pairs out of the added/deleted lists by matching identical content hashes,
 * mutating both lists in place to remove the matched paths.
 */
function extractRenames(
  added: string[],
  deleted: string[],
  prev: Map<string, FileRecord>,
  curr: Map<string, FileRecord>,
): SnapshotDiff['renamed'] {
  const renamed: SnapshotDiff['renamed'] = [];
  const deletedByHash = new Map<string, string[]>();
  for (const path of deleted) {
    const hash = prev.get(path)?.blob_hash;
    if (hash === undefined) continue;
    const bucket = deletedByHash.get(hash);
    if (bucket) bucket.push(path);
    else deletedByHash.set(hash, [path]);
  }

  const matchedAdded = new Set<string>();
  const matchedDeleted = new Set<string>();
  for (const to of added) {
    const hash = curr.get(to)?.blob_hash;
    if (hash === undefined) continue;
    const candidates = deletedByHash.get(hash);
    const from = candidates?.find((p) => !matchedDeleted.has(p));
    if (from) {
      renamed.push({ from, to });
      matchedAdded.add(to);
      matchedDeleted.add(from);
    }
  }

  removeInPlace(added, matchedAdded);
  removeInPlace(deleted, matchedDeleted);
  return renamed;
}

function removeInPlace(list: string[], toRemove: Set<string>): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item !== undefined && toRemove.has(item)) list.splice(i, 1);
  }
}
