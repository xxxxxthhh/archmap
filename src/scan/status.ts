/**
 * Read-only status: compare the live working tree against the committed snapshot and report
 * what changed and which nodes are stale. Never writes — `scan` is what refreshes the model.
 */

import { buildIndex, readProject, type DerivedIndex } from '../store.js';
import { readTrackedBaseline } from './baseline.js';
import { discover } from './discover.js';
import { containingNodeId, rootNodeId } from './nodes.js';
import { modelDrift, prospectiveModel } from './projection.js';
import { diffSnapshot } from './snapshot.js';
import type { SnapshotDiff } from './types.js';

export interface StatusResult {
  scanned: boolean;
  clean: boolean;
  /** HEAD the snapshot was based on. */
  base_commit: string | null;
  /** Whether the snapshot itself was taken against a dirty working tree. */
  dirty: boolean;
  diff: SnapshotDiff | null;
  /**
   * Why the tracked model no longer matches a scan of the current inputs, independent of the
   * file list: `snapshot-metadata` (commit/dirty/capabilities/exclusions) and/or
   * `node-structure` (a config-derived title or scope changed). Empty when current.
   */
  drift: string[];
  /** Nodes scoping (or that would contain) a changed file. */
  stale_nodes: string[];
  file_count: number;
  node_count: number;
}

export function computeStatus(root: string): StatusResult {
  // Shared validated read path: an invalid tracked model fails closed (StoreFormatError).
  const baseline = readTrackedBaseline(root);

  if (!baseline) {
    return {
      scanned: false,
      clean: false,
      base_commit: null,
      dirty: false,
      diff: null,
      drift: [],
      stale_nodes: [],
      file_count: 0,
      node_count: 0,
    };
  }

  const { snapshot, nodes } = baseline;
  const project = readProject(root);
  const discovery = discover(root, project.scan);
  const diff = diffSnapshot(snapshot.files, discovery.files);
  const filesChanged =
    diff.added.length > 0 ||
    diff.modified.length > 0 ||
    diff.deleted.length > 0 ||
    diff.renamed.length > 0;

  // Clean means the whole scanner-owned projection for the current inputs is unchanged — not
  // just the file list. Uses the same shared projection/comparison as `scan --changed`, so
  // the two never disagree (and enrichment on a node does not read as drift).
  const drift = modelDrift(prospectiveModel(discovery, project.project.name, nodes), snapshot, nodes);
  const clean = !filesChanged && drift.length === 0;

  // Build the index from the tracked nodes just read — authoritative and immune to a stale
  // or cross-branch cache (the disposable cache is never trusted for stale detection).
  const stale = computeStaleNodes(diff, new Set(nodes.map((n) => n.id)), buildIndex(nodes));

  return {
    scanned: true,
    clean,
    base_commit: snapshot.base_commit,
    dirty: snapshot.dirty,
    diff,
    drift,
    stale_nodes: stale,
    file_count: discovery.files.length,
    node_count: nodes.length,
  };
}

function computeStaleNodes(
  diff: SnapshotDiff,
  known: Set<string>,
  index: DerivedIndex,
): string[] {
  const stale = new Set<string>();
  const lookup = (path: string): string[] =>
    Object.prototype.hasOwnProperty.call(index.file_to_nodes, path)
      ? index.file_to_nodes[path]!
      : [];

  // Files already scoped by a node: modification/deletion/move makes that node stale.
  const scopedPaths = [...diff.modified, ...diff.deleted, ...diff.renamed.map((r) => r.from)];
  for (const path of scopedPaths) {
    for (const id of lookup(path)) stale.add(id);
  }

  // Added files (and rename destinations) are not yet in any scope. Mark the node that
  // would contain them (if it exists) plus the repository root, whose structure changed.
  const newPaths = [...diff.added, ...diff.renamed.map((r) => r.to)];
  for (const path of newPaths) {
    const containing = containingNodeId(path);
    if (known.has(containing)) stale.add(containing);
    if (known.has(rootNodeId())) stale.add(rootNodeId());
  }

  return [...stale].sort();
}
