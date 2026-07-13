/**
 * Repository-owned storage under `.archmap/` (PLAN 6.1) plus the disposable derived cache
 * (6.2). Tracked artifacts are written as canonical YAML so they are reviewable and diff
 * stably; the cache is JSON and may be deleted and rebuilt at any time.
 *
 * All access is boundary-safe. Every path component from `.archmap` down is checked with
 * `lstat`: a symlink is rejected (so a repository cannot plant a link to read or clobber
 * files outside itself), and each component must be of the expected type (directory vs
 * regular file). Final file I/O uses `O_NOFOLLOW`. Plain filesystem errors are wrapped as
 * `StorePathError` so callers always get a stable error rather than a raw stack trace.
 */

import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { toCanonicalJson, toCanonicalYaml } from './model/canonical.js';
import type { Capability, Node } from './model/types.js';
import { hashContent } from './scan/hash.js';
import type { ProjectConfig, Snapshot } from './scan/types.js';
import { StoreFormatError, StorePathError } from './store-errors.js';
import { parseNodeDocument, parseProjectConfig, parseSnapshot } from './validate/store-contracts.js';
import { validateManifest } from './validate/validate.js';

export const ARCHMAP_DIR = '.archmap';

export const paths = {
  dir: (root: string) => join(root, ARCHMAP_DIR),
  project: (root: string) => join(root, ARCHMAP_DIR, 'project.yaml'),
  snapshot: (root: string) => join(root, ARCHMAP_DIR, 'snapshot.yaml'),
  nodesDir: (root: string) => join(root, ARCHMAP_DIR, 'nodes'),
  cacheDir: (root: string) => join(root, ARCHMAP_DIR, 'cache'),
  index: (root: string) => join(root, ARCHMAP_DIR, 'cache', 'index.json'),
};

// --- boundary-safe primitives ------------------------------------------------------------

type ComponentType = 'dir' | 'file';

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/**
 * Validate one existing path component: reject symlinks, require the expected type, and map
 * unexpected filesystem errors to `StorePathError`. A non-existent component (`ENOENT`) is
 * allowed — it will be created.
 */
function checkComponent(path: string, label: string, expect: ComponentType): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (errno(err) === 'ENOENT') return;
    throw new StorePathError(`cannot access archmap store path ${label} (${errno(err) ?? 'error'})`);
  }
  if (stat.isSymbolicLink()) {
    throw new StorePathError(`refusing to follow symlink in archmap store: ${label}`);
  }
  if (expect === 'dir' && !stat.isDirectory()) {
    throw new StorePathError(`expected a directory at archmap store path: ${label}`);
  }
  if (expect === 'file' && !stat.isFile()) {
    throw new StorePathError(`expected a regular file at archmap store path: ${label}`);
  }
}

/** Resolve `root/<parts...>`, validating every component. Intermediate parts must be
 * directories; the leaf must be `leafType`. */
function safe(root: string, parts: string[], leafType: ComponentType): string {
  let current = root;
  parts.forEach((part, i) => {
    current = join(current, part);
    const isLeaf = i === parts.length - 1;
    checkComponent(current, parts.slice(0, i + 1).join('/'), isLeaf ? leafType : 'dir');
  });
  return current;
}

const safeDir = (root: string, parts: string[]): string => safe(root, parts, 'dir');
const safeFile = (root: string, parts: string[]): string => safe(root, parts, 'file');

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    throw new StorePathError(`cannot create archmap store directory ${path} (${errno(err) ?? 'error'})`);
  }
}

/** Close a descriptor without masking a primary error already in flight. */
function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The caller is already throwing the primary error; a close failure must not replace it.
  }
}

function writeTextNoFollow(path: string, text: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    throw new StorePathError(`cannot write archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
  try {
    // Loop: a single writeSync may perform a short write on large payloads.
    const buf = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written === 0) throw new StorePathError(`short write to archmap store file ${path}`);
      offset += written;
    }
  } catch (err) {
    closeQuiet(fd); // preserve the write error below
    if (err instanceof StorePathError) throw err;
    throw new StorePathError(`cannot write archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
  // Success path: a close failure here is itself a real error worth surfacing.
  try {
    closeSync(fd);
  } catch (err) {
    throw new StorePathError(`cannot close archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
}

function readTextNoFollow(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    throw new StorePathError(`cannot read archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
  let text: string;
  try {
    text = readFileSync(fd, 'utf8');
  } catch (err) {
    closeQuiet(fd); // preserve the read error below
    throw new StorePathError(`cannot read archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
  try {
    closeSync(fd);
  } catch (err) {
    throw new StorePathError(`cannot close archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
  return text;
}

/** List a directory, treating a missing directory as empty and wrapping other errors. */
function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (errno(err) === 'ENOENT') return [];
    throw new StorePathError(`cannot list archmap store directory ${path} (${errno(err) ?? 'error'})`);
  }
}

/** Remove a file, treating a missing file as done and wrapping other errors. */
function safeRm(path: string): void {
  try {
    rmSync(path);
  } catch (err) {
    if (errno(err) === 'ENOENT') return;
    throw new StorePathError(`cannot remove archmap store file ${path} (${errno(err) ?? 'error'})`);
  }
}

/**
 * True when `<root>/.archmap/project.yaml` exists as a real regular file. Uses the same
 * component-by-component boundary check as every other store access — so a symlinked
 * `.archmap` (or `project.yaml`) fails closed with `StorePathError` rather than being
 * followed, keeping `init`/discovery consistent with reads.
 */
function hasProjectFile(root: string): boolean {
  return existsSync(safeFile(root, [ARCHMAP_DIR, 'project.yaml']));
}

// --- project / init ----------------------------------------------------------------------

/** True when `root` has been initialized with a real `project.yaml`. */
export function isInitialized(root: string): boolean {
  return hasProjectFile(root);
}

/** Walk up from `start` to find a directory whose `.archmap/project.yaml` is a real file. */
export function resolveProjectRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (hasProjectFile(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeProject(root: string, config: ProjectConfig): void {
  ensureDir(safeDir(root, [ARCHMAP_DIR]));
  ensureDir(safeDir(root, [ARCHMAP_DIR, 'nodes']));
  // Keep the disposable cache out of Git in whatever repository archmap runs against; the
  // tracked project/snapshot/nodes remain visible (PLAN 6.2).
  writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, '.gitignore']), 'cache/\ntmp/\n');
  writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'project.yaml']), toCanonicalYaml(config));
}

export function readProject(root: string): ProjectConfig {
  return parseProjectConfig(readTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'project.yaml'])));
}

// --- snapshot ----------------------------------------------------------------------------

export function writeSnapshot(root: string, snapshot: Snapshot): void {
  writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'snapshot.yaml']), toCanonicalYaml(snapshot));
}

export function readSnapshot(root: string): Snapshot | null {
  const path = safeFile(root, [ARCHMAP_DIR, 'snapshot.yaml']);
  if (!existsSync(path)) return null;
  return parseSnapshot(readTextNoFollow(path));
}

// --- nodes -------------------------------------------------------------------------------

/** Serialize a node as a versioned tracked document. */
function serializeNode(node: Node): string {
  return toCanonicalYaml({ schema_version: 1, ...node });
}

/** Replace the tracked node set: clear existing node files, then write the current ones. */
export function writeNodes(root: string, nodes: Node[]): void {
  const dir = safeDir(root, [ARCHMAP_DIR, 'nodes']);
  ensureDir(dir);
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    safeRm(safeFile(root, [ARCHMAP_DIR, 'nodes', entry])); // safeFile rejects symlink/dir entries
  }
  for (const node of nodes) {
    writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'nodes', `${node.id}.yaml`]), serializeNode(node));
  }
}

/**
 * Parse each tracked node document (structural + version routing only). This does NOT
 * enforce cross-node or capability semantics — use `readValidatedNodes` when consuming the
 * model, so the full M0 contract is applied rather than a weaker structural check.
 */
/** Names of tracked node files, without parsing them. */
export function listNodeFiles(root: string): string[] {
  return safeReaddir(safeDir(root, [ARCHMAP_DIR, 'nodes'])).filter((e) => e.endsWith('.yaml'));
}

/** Raw bytes of the snapshot file, or null when absent. */
function readSnapshotRaw(root: string): string | null {
  const p = safeFile(root, [ARCHMAP_DIR, 'snapshot.yaml']);
  return existsSync(p) ? readTextNoFollow(p) : null;
}

/** Raw bytes of every tracked node file, keyed by filename. */
function readNodeFilesRaw(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of listNodeFiles(root).sort()) {
    files.set(name, readTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'nodes', name])));
  }
  return files;
}

function nodeFilesMatch(root: string, expected: Map<string, string>): boolean {
  const current = readNodeFilesRaw(root);
  if (current.size !== expected.size) return false;
  for (const [name, text] of expected) {
    if (current.get(name) !== text) return false;
  }
  return true;
}

function restoreBaseline(root: string, oldSnapshot: string | null, oldNodes: Map<string, string>): void {
  const snapPath = safeFile(root, [ARCHMAP_DIR, 'snapshot.yaml']);
  if (oldSnapshot === null) safeRm(snapPath);
  else writeTextNoFollow(snapPath, oldSnapshot);

  // Only rewrite nodes if they actually changed — avoids touching a (read-only) nodes dir
  // when the failure happened before any node file was modified.
  if (!nodeFilesMatch(root, oldNodes)) {
    for (const name of listNodeFiles(root)) {
      safeRm(safeFile(root, [ARCHMAP_DIR, 'nodes', name]));
    }
    for (const [name, text] of oldNodes) {
      writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'nodes', name]), text);
    }
  }
}

/**
 * Publish snapshot + node set as one unit. On any write failure the tracked baseline is
 * rolled back to its byte-identical prior state before the error is re-raised, so a plain
 * exception (e.g. EACCES) can never leave a half-updated, unreadable model. This is
 * exception-safe rollback, not crash-safe: a process kill mid-write is out of scope for M1.
 */
export function publishModel(root: string, snapshot: Snapshot, nodes: Node[]): void {
  const oldSnapshot = readSnapshotRaw(root);
  const oldNodes = readNodeFilesRaw(root);
  try {
    writeSnapshot(root, snapshot);
    writeNodes(root, nodes);
  } catch (err) {
    try {
      restoreBaseline(root, oldSnapshot, oldNodes);
    } catch (rollbackErr) {
      throw new StorePathError(
        `scan write failed and rollback also failed (${(rollbackErr as Error).message}); ` +
          `original error: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}

export function readNodes(root: string): Node[] {
  const dir = safeDir(root, [ARCHMAP_DIR, 'nodes']);
  return safeReaddir(dir)
    .filter((e) => e.endsWith('.yaml'))
    .sort()
    .map((e) => parseNodeDocument(readTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'nodes', e]))));
}

/**
 * Read the tracked nodes and validate them as a single Manifest against the M0 contract
 * (structure, provenance/type, id uniqueness, relation reference integrity, and the
 * evidence↔capability rules), using `capabilities` for the capability linkage checks.
 * Any violation is wrapped as `StoreFormatError`. This is the read path model consumers use.
 */
export function readValidatedNodes(root: string, capabilities: Capability[]): Node[] {
  const nodes = readNodes(root);
  const result = validateManifest({ schema_version: 1, capabilities, nodes });
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path} ${e.message}`).join('; ');
    throw new StoreFormatError(`invalid node model: ${detail}`);
  }
  return nodes;
}

// --- derived index (disposable cache) ----------------------------------------------------

/**
 * The derived file → node-ids index. `fingerprint` binds it to the node set it was built
 * from so a consumer can detect a stale cache. Status never trusts this cache for
 * correctness — it rebuilds from tracked nodes — but scan keeps it fresh as the derived
 * artifact (PLAN 6.2).
 */
export interface DerivedIndex {
  fingerprint: string;
  file_to_nodes: Record<string, string[]>;
}

/** Build the file → node-ids map from a node set, using a null-prototype dictionary so any
 * legal path (including `__proto__`) is a safe own property. */
export function buildIndex(nodes: Node[]): DerivedIndex {
  const fileToNodes: Record<string, string[]> = Object.create(null);
  for (const node of nodes) {
    for (const file of node.scope?.files ?? []) {
      (fileToNodes[file] ??= []).push(node.id);
    }
  }
  return {
    fingerprint: hashContent(Buffer.from(toCanonicalJson(fileToNodes))),
    file_to_nodes: fileToNodes,
  };
}

export function writeIndex(root: string, index: DerivedIndex): void {
  ensureDir(safeDir(root, [ARCHMAP_DIR, 'cache']));
  writeTextNoFollow(safeFile(root, [ARCHMAP_DIR, 'cache', 'index.json']), toCanonicalJson(index));
}
