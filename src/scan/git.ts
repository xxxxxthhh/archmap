/**
 * Thin git wrappers. All calls use explicit argv via `spawnSync` (never a shell string, per
 * PLAN 14). `isGitRepo`/`repoToplevel` degrade to `false`/`null` for non-repositories, but
 * once a directory *is* a git work tree, `collectGitState` fails closed on any git error —
 * falling back to a raw filesystem walk there would ignore `.gitignore` and produce a wrong,
 * unfiltered model with a misleading commit/dirty state.
 */

import { spawnSync } from 'node:child_process';
import { ScanInputError } from '../store-errors.js';

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(root: string, args: string[]): GitResult {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || res.error) {
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: res.stdout.toString('utf8') };
}

/** True when `root` is inside a git work tree. */
export function isGitRepo(root: string): boolean {
  const res = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.trim() === 'true';
}

/** Repository top-level directory, or null when not a git repo. */
export function repoToplevel(root: string): string | null {
  const { ok, stdout } = git(root, ['rev-parse', '--show-toplevel']);
  const top = stdout.trim();
  return ok && top.length > 0 ? top : null;
}

export interface GitState {
  /** Tracked + untracked-but-not-ignored files, relative to `root`. */
  files: string[];
  /** HEAD commit, or null for an unborn repository (no commits). */
  base_commit: string | null;
  /** Whether the working tree diverges from HEAD, ignoring archmap's own `.archmap/`. */
  dirty: boolean;
}

/**
 * Collect the git view of `root`. Must only be called when `isGitRepo(root)` is true. If
 * `git ls-files` or `git status` fails, the repository's git metadata is unusable (e.g. an
 * unreadable index) — this throws `ScanInputError` rather than silently degrading. A failed
 * `rev-parse HEAD` after a successful `ls-files` means the repo is unborn (no commits), which
 * is a legitimate `base_commit: null`.
 */
export function collectGitState(root: string): GitState {
  const ls = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (!ls.ok) {
    throw new ScanInputError(
      'git ls-files failed in a git repository; refusing to fall back to an unfiltered ' +
        'filesystem scan (which would ignore .gitignore)',
    );
  }
  const files = ls.stdout.split('\0').filter((p) => p.length > 0);

  const status = git(root, ['status', '--porcelain', '--', '.', ':(exclude).archmap']);
  if (!status.ok) {
    throw new ScanInputError('git status failed in a git repository');
  }
  const dirty = status.stdout.trim().length > 0;

  const head = git(root, ['rev-parse', 'HEAD']);
  const sha = head.stdout.trim();
  const base_commit = head.ok && sha.length > 0 ? sha : null; // null == unborn repository

  return { files, base_commit, dirty };
}

// --- read-only ref/tree access (M5 diff) -------------------------------------------------
//
// These helpers read historical tracked state straight from the object store; none of them
// touch the working tree, so an `archmap diff` cannot mutate the caller's checkout. All refs
// go through explicit argv (no shell), and `--end-of-options` keeps a hostile ref like
// `--upload-pack=...` from ever being parsed as a git option.

/**
 * Resolve `ref` to a full 40-hex commit SHA, or null when it is not an existing commit-ish
 * (unknown ref, malformed rev, a tag/blob that is not commit-ish, or not a git repository).
 * Peeling with `^{commit}` means a tag resolves to the commit it points at, and anything that
 * cannot be a commit fails closed as null rather than being diffed against.
 */
export function resolveCommit(root: string, ref: string): string | null {
  const res = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = res.stdout.trim();
  return res.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * List the repository-root-relative paths of every file under `dir` in `commit`'s tree
 * (recursive). Returns `[]` when the directory does not exist at that commit. `commit` must be
 * a resolved SHA from `resolveCommit`; `dir` is a pathspec relative to `root`.
 */
export function listTreeFiles(root: string, commit: string, dir: string): string[] {
  const res = git(root, ['ls-tree', '-r', '--name-only', '-z', commit, '--', dir]);
  if (!res.ok) return [];
  return res.stdout.split('\0').filter((p) => p.length > 0);
}

/**
 * Read the blob at `path` (repository-root-relative) in `commit`'s tree, or null when the path
 * does not exist there. `commit` must be a resolved SHA from `resolveCommit`.
 */
export function readTreeFile(root: string, commit: string, path: string): string | null {
  const res = git(root, ['show', `${commit}:${path}`]);
  return res.ok ? res.stdout : null;
}
