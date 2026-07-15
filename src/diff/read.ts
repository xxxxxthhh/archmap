/**
 * Read the tracked architecture model (`.archmap/nodes/*.yaml`) at a resolved commit, straight
 * from the git object store — never the working tree. Each node document is parsed and
 * structurally validated with the same contract the live store uses, so an incompatible or
 * malformed historical state fails closed rather than being diffed as if it were empty.
 *
 * A commit that predates archmap (no `.archmap/nodes/`) is a legitimate empty model, not an
 * error: everything then reads as added/removed against the other side.
 */

import { ARCHMAP_DIR } from '../store.js';
import { StoreFormatError } from '../store-errors.js';
import { parseNodeDocument, parseSnapshot } from '../validate/store-contracts.js';
import { validateManifest } from '../validate/validate.js';
import { listTreeFiles, readTreeFile } from '../scan/git.js';
import type { Node } from '../model/types.js';

const NODES_DIR = `${ARCHMAP_DIR}/nodes`;
const SNAPSHOT_PATH = `${ARCHMAP_DIR}/snapshot.yaml`;

/**
 * The nodes tracked at `commit`. `root` is the archmap project directory (git commands run
 * there); `commit` must already be resolved by `resolveCommit`. Duplicate ids across the
 * node set — which a valid manifest can never contain — fail closed so the diff can never
 * silently collapse two distinct identities into one.
 */
export function readNodesAt(root: string, commit: string): Node[] {
  const nodes: Node[] = [];
  const ids = new Set<string>();
  const paths = listTreeFiles(root, commit, NODES_DIR)
    .filter((path) => path.endsWith('.yaml'))
    .sort();

  const snapshotText = readTreeFile(root, commit, SNAPSHOT_PATH);
  // A pre-archmap commit has neither nodes nor a snapshot and is intentionally an empty
  // model. Any snapshot that does exist is part of the tracked baseline, even when its node
  // directory is empty, so malformed historical state never silently reads as empty.
  if (paths.length === 0 && snapshotText === null) return nodes;
  if (snapshotText === null) {
    throw new StoreFormatError(`tracked nodes at ${commit.slice(0, 12)} exist without a snapshot`);
  }
  const snapshot = parseSnapshot(snapshotText);

  for (const path of paths) {
    const text = readTreeFile(root, commit, path);
    // listTreeFiles just reported this path, so a null read is a genuine object-store fault.
    if (text === null) {
      throw new StoreFormatError(`cannot read tracked node ${path} at ${commit.slice(0, 12)}`);
    }
    const node = parseNodeDocument(text);
    if (ids.has(node.id)) {
      throw new StoreFormatError(
        `duplicate node id "${node.id}" in tracked state at ${commit.slice(0, 12)}`,
      );
    }
    ids.add(node.id);
    nodes.push(node);
  }

  const validation = validateManifest({ schema_version: 1, capabilities: snapshot.capabilities, nodes });
  if (!validation.valid) {
    const detail = validation.errors.map((error) => `${error.path} ${error.message}`).join('; ');
    throw new StoreFormatError(`invalid tracked node model at ${commit.slice(0, 12)}: ${detail}`);
  }
  return nodes;
}
