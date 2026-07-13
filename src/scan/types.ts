/** Types for the M1 universal scanner: project config, snapshot, discovery, and diffs. */

import type { Capability } from '../model/types.js';

/** Why a candidate file was left out of the snapshot. */
export type ExclusionReason = 'excluded-dir' | 'secret' | 'too-large' | 'binary' | 'symlink';

/** Coarse classification of a file, the universal adapter's manifest/doc/config discovery. */
export type FileCategory = 'manifest' | 'doc' | 'config' | 'source' | 'other';

/** A re-verifiable file fact: content identity and classification at a path. */
export interface FileRecord {
  path: string;
  blob_hash: string;
  size: number;
  category: FileCategory;
}

/**
 * The deterministic file ledger written by `scan`. Contains no wall-clock data, so a
 * re-scan with no content change reproduces it byte-for-byte.
 *
 * The scanner reads working-tree content, which may differ from `base_commit`; `dirty`
 * records that divergence so blob hashes are never mistaken for `base_commit`'s blobs.
 */
export interface Snapshot {
  schema_version: 1;
  /** HEAD the working tree is based on, or null for a repo with no commits / no git. */
  base_commit: string | null;
  /** True when the scanned working tree differs from `base_commit`. */
  dirty: boolean;
  capabilities: Capability[];
  files: FileRecord[];
  excluded_counts: Record<ExclusionReason, number>;
}

/** Repository-owned configuration written by `init`. */
export interface ProjectConfig {
  schema_version: 1;
  project: {
    id: string;
    name: string;
  };
  scan: {
    max_file_bytes: number;
    exclude_dirs: string[];
    secret_globs: string[];
  };
}

/** Result of walking + filtering the repository. */
export interface Discovery {
  root: string;
  base_commit: string | null;
  dirty: boolean;
  git_available: boolean;
  files: FileRecord[];
  excluded_counts: Record<ExclusionReason, number>;
}

/** A rename detected by identical content appearing at a new path. */
export interface RenamePair {
  from: string;
  to: string;
}

/** Difference between a previous snapshot and current discovery. */
export interface SnapshotDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: RenamePair[];
  unchanged: number;
}
