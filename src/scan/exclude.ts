/**
 * Safe-default exclusion rules (PLAN 14). These apply on top of `.gitignore` so vendor,
 * build, cache, secret, oversized, and binary content stay out of the model even in repos
 * that commit such files. Evidence never stores content — only pointers and hashes.
 */

import type { ExclusionReason } from './types.js';

/** Directory names excluded anywhere in a path. */
export const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  '.git',
  '.archmap',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.terraform',
  '.idea',
  '.vscode',
];

/** Glob-ish patterns (matched against the basename) for likely secrets. */
export const DEFAULT_SECRET_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.keystore',
  '*.jks',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.npmrc',
  '.pypirc',
  'credentials',
];

export const DEFAULT_MAX_FILE_BYTES = 5_000_000;

/** Bytes of a file sampled to decide whether it is binary. */
export const BINARY_SNIFF_BYTES = 8192;

/** Compile a basename glob into a matcher. Only `*` is a wildcard; every other character —
 * including regex metacharacters like `?`, `[`, `\`, `+`, `(` — matches literally. Splitting
 * on `*` first and escaping each segment fully means no input can form an invalid RegExp. */
function globToMatcher(glob: string): (name: string) => boolean {
  const pattern = glob
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${pattern}$`);
  return (name) => re.test(name);
}

export interface ExclusionRules {
  excludeDirs: Set<string>;
  secretMatchers: Array<(name: string) => boolean>;
  maxFileBytes: number;
}

export function buildExclusionRules(config: {
  exclude_dirs: string[];
  secret_globs: string[];
  max_file_bytes: number;
}): ExclusionRules {
  return {
    excludeDirs: new Set(config.exclude_dirs),
    secretMatchers: config.secret_globs.map(globToMatcher),
    maxFileBytes: config.max_file_bytes,
  };
}

/**
 * Reason a path is excluded by name alone (directory or secret), or null if it passes the
 * name-based checks. Size and binary checks require reading the file and are done by the
 * caller.
 */
export function excludeByName(relPath: string, rules: ExclusionRules): ExclusionReason | null {
  const segments = relPath.split('/');
  const basename = segments[segments.length - 1] ?? relPath;

  for (const segment of segments.slice(0, -1)) {
    if (rules.excludeDirs.has(segment)) return 'excluded-dir';
  }
  if (rules.excludeDirs.has(basename)) return 'excluded-dir';

  if (rules.secretMatchers.some((match) => match(basename))) return 'secret';

  return null;
}

/** Heuristic binary detection: a NUL byte in the sampled prefix. */
export function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}
