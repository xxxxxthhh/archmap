/**
 * Deterministic file classification — the universal adapter's manifest/doc/config discovery.
 *
 * Classification is purely a function of the path (never content), so it never affects scan
 * determinism. Precedence is manifest → doc → config → source → other; the first match wins,
 * so specific manifests (e.g. `package.json`) are not mislabeled as generic config.
 */

import type { FileCategory } from './types.js';

/** Exact basenames that identify a dependency/build manifest. */
const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'gemfile',
  'gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'composer.lock',
]);

const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'rst', 'adoc']);
const DOC_STEMS = ['readme', 'changelog', 'license', 'licence', 'contributing', 'authors', 'notice'];

const CONFIG_EXTS = new Set([
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'json',
  'json5',
  'properties',
  'xml',
  'env',
]);
const CONFIG_NAMES = new Set([
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.npmignore',
  '.prettierrc',
  '.eslintrc',
  'dockerfile',
  'makefile',
]);

const SOURCE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh',
  'lua', 'r', 'sql', 'vue', 'svelte',
]);

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Lowercased extension without the dot, or '' when there is none. */
function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function classify(path: string): FileCategory {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;

  if (MANIFEST_NAMES.has(name) || /^requirements[\w.-]*\.txt$/.test(name)) return 'manifest';
  if (DOC_EXTS.has(ext) || DOC_STEMS.includes(stem)) return 'doc';
  if (CONFIG_NAMES.has(name) || CONFIG_EXTS.has(ext)) return 'config';
  if (SOURCE_EXTS.has(ext)) return 'source';
  return 'other';
}
