/**
 * M1 tracked-model consistency: the cross-artifact invariants between `snapshot.yaml` and the
 * tracked node set that the M0 manifest validation cannot express. Without these, a node
 * document that is individually valid (passes the node schema and `validateManifest`) can
 * still silently break stale detection — e.g. a node whose scope was emptied, or a deleted
 * node set — so a modified file maps to no stale node.
 *
 * The invariants are defined by the structural baseline `buildNodes(snapshot.files, …)`
 * produces; they check coverage and containment, not byte-equality, so future claims and
 * relations on a node do not trip them.
 */

import type { Node } from '../model/types.js';
import { StoreFormatError } from '../store-errors.js';
import { containingNodeId, rootNodeId } from './nodes.js';
import type { FileRecord } from './types.js';

/**
 * Throw `StoreFormatError` if the tracked `nodes` are inconsistent with `files` (the scanned
 * snapshot): the repository root node must exist, every snapshot file must be covered by its
 * expected containing node, and no node scope may reference a path outside the snapshot.
 */
export function assertModelConsistency(files: FileRecord[], nodes: Node[]): void {
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (!nodeIds.has(rootNodeId())) {
    throw new StoreFormatError('tracked model is missing the repository root node');
  }

  const scopeByFile = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const file of node.scope?.files ?? []) {
      (scopeByFile.get(file) ?? scopeByFile.set(file, new Set()).get(file)!).add(node.id);
    }
  }

  const snapshotFiles = new Set(files.map((f) => f.path));

  // Coverage + stale mapping: every scanned file must sit in its expected containing node.
  for (const file of snapshotFiles) {
    const containing = containingNodeId(file);
    if (!nodeIds.has(containing)) {
      throw new StoreFormatError(`snapshot file "${file}" has no structural node "${containing}"`);
    }
    if (!scopeByFile.get(file)?.has(containing)) {
      throw new StoreFormatError(`snapshot file "${file}" is not covered by node "${containing}"`);
    }
  }

  // Reverse: a node must not scope a path that the snapshot does not contain.
  for (const file of scopeByFile.keys()) {
    if (!snapshotFiles.has(file)) {
      throw new StoreFormatError(`node scope references "${file}", absent from the snapshot`);
    }
  }
}
