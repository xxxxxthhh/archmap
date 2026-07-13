/**
 * Repository discovery: enumerate candidate files, apply safe-default exclusions, and hash
 * the survivors into a deterministic, path-sorted file list.
 *
 * Candidates come from `git ls-files` when possible (so `.gitignore` and `.git` are handled
 * by git itself); otherwise a filesystem walk is used. The archmap exclusion rules then
 * apply on top, regardless of how candidates were produced.
 */

import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { classify } from './classify.js';
import { hashContent } from './hash.js';
import {
  BINARY_SNIFF_BYTES,
  buildExclusionRules,
  excludeByName,
  looksBinary,
  type ExclusionRules,
} from './exclude.js';
import { collectGitState, isGitRepo } from './git.js';
import { isPython, isTsJs } from '../analyze/languages.js';
import { ARCHMAP_DIR } from '../store.js';
import { ScanInputError } from '../store-errors.js';
import type { Discovery, ExclusionReason, FileRecord, ProjectConfig } from './types.js';

const READ_CHUNK_BYTES = 64 * 1024;

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** archmap's own derived directory is never repository content; skip it before counting. */
function isArchmapOwnPath(relPath: string): boolean {
  return relPath === ARCHMAP_DIR || relPath.startsWith(`${ARCHMAP_DIR}/`);
}

function emptyCounts(): Record<ExclusionReason, number> {
  return { 'excluded-dir': 0, secret: 0, 'too-large': 0, binary: 0, symlink: 0 };
}

type CandidateRead =
  | { kind: 'file'; content: Buffer; size: number }
  | { kind: 'skip' } // absent (raced deletion) or not a regular file
  | { kind: 'symlink' }
  | { kind: 'too-large' };

/**
 * Read a candidate file for hashing. Uses an `O_NOFOLLOW` descriptor so a symlink is rejected
 * atomically (no lstat→read TOCTOU, and the symlink is never followed). Only a genuinely
 * absent path (`ENOENT`) is skipped; any other error (EACCES/EIO/EMFILE/…) is a `ScanInputError`
 * — an unreadable file must never be silently treated as a deletion.
 */
function readCandidate(abs: string, maxBytes: number): CandidateRead {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = errno(err);
    if (code === 'ELOOP') return { kind: 'symlink' };
    if (code === 'ENOENT') return { kind: 'skip' };
    throw new ScanInputError(`cannot open source file ${abs} (${code ?? 'error'})`);
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'skip' }; // submodule/gitlink, socket, fifo, dir
    // Read at most maxBytes+1 bytes so the too-large decision and the hashed content come from
    // the same bytes — never fstat.size (which can disagree with what is actually read). The
    // per-read length is clamped to the remaining quota (invariant: total <= maxBytes at the
    // top of the loop, so `want` is always >= 1) to honor that bound exactly.
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      const n = readSync(fd, buffer, 0, want, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return { kind: 'too-large' };
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    return { kind: 'file', content: Buffer.concat(chunks, total), size: total };
  } catch (err) {
    throw new ScanInputError(`cannot read source file ${abs} (${errno(err) ?? 'error'})`);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read result is already captured; a close failure must not mask it.
    }
  }
}

/** Recursively list files under `dir`, pruning excluded directories as it descends. An
 * unreadable directory (other than a raced deletion) fails the scan rather than being skipped. */
function walkFilesystem(root: string, dir: string, rules: ExclusionRules, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (errno(err) === 'ENOENT') return;
    throw new ScanInputError(`cannot list directory ${dir} (${errno(err) ?? 'error'})`);
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (rules.excludeDirs.has(entry.name)) continue;
      walkFilesystem(root, abs, rules, out);
    } else if (entry.isFile()) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  }
}

/**
 * Discover included files under `root`. `config` supplies exclusion thresholds; missing git
 * degrades to a filesystem walk with `git_available: false`.
 */
export function discover(root: string, config: ProjectConfig['scan']): Discovery {
  const rules = buildExclusionRules(config);
  const gitAvailable = isGitRepo(root);

  // In a git repository we rely entirely on git (so `.gitignore` is honored and the
  // commit/dirty state is real); any git failure fails the scan closed rather than degrading
  // to a raw walk. Only genuinely non-git directories use the filesystem walk.
  let candidates: string[];
  let baseCommit: string | null = null;
  let dirty = false;
  if (gitAvailable) {
    const state = collectGitState(root);
    candidates = state.files;
    baseCommit = state.base_commit;
    dirty = state.dirty;
  } else {
    const walked: string[] = [];
    walkFilesystem(root, root, rules, walked);
    candidates = walked;
  }

  const excludedCounts = emptyCounts();
  const files: FileRecord[] = [];
  const contents = new Map<string, Buffer>();

  for (const relPath of candidates) {
    if (isArchmapOwnPath(relPath)) continue;

    const nameReason = excludeByName(relPath, rules);
    if (nameReason) {
      excludedCounts[nameReason] += 1;
      continue;
    }

    const result = readCandidate(join(root, relPath), rules.maxFileBytes);
    if (result.kind === 'skip') continue;
    if (result.kind === 'symlink') {
      excludedCounts.symlink += 1;
      continue;
    }
    if (result.kind === 'too-large') {
      excludedCounts['too-large'] += 1;
      continue;
    }
    if (looksBinary(result.content.subarray(0, BINARY_SNIFF_BYTES))) {
      excludedCounts.binary += 1;
      continue;
    }
    files.push({
      path: relPath,
      blob_hash: hashContent(result.content),
      size: result.size,
      category: classify(relPath),
    });
    // Retain analyzed bytes (and root language manifests used for import resolution) so each
    // adapter sees exactly what was hashed. Python packaging metadata is only dependency
    // declaration input; this does not enable the later YAML/JSON data-I/O adapter scope.
    if (
      isTsJs(relPath) ||
      isPython(relPath) ||
      relPath === 'package.json' ||
      relPath === 'tsconfig.json' ||
      relPath === 'pyproject.toml' ||
      relPath === 'requirements.txt'
    ) {
      contents.set(relPath, result.content);
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    root,
    base_commit: baseCommit,
    dirty,
    git_available: gitAvailable,
    files,
    excluded_counts: excludedCounts,
    contents,
  };
}
