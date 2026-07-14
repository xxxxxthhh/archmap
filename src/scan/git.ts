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
