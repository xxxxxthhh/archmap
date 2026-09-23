#!/usr/bin/env node
// Flagship demo: run the real ArchMap CLI through a maintenance loop on the synthetic
// `examples/lending-desk` sample — init -> scan -> context/impact/evidence -> source edit ->
// stale -> rescan — and optionally record the sanitized results for the static homepage.
//
// Safety boundary: the script takes no target path. It copies the checked-in sample into a
// directory it creates with mkdtemp, runs every Git and ArchMap command there with an isolated
// Git configuration, and removes only that directory. The checked-in sample is never modified.
//
// Usage (from an ArchMap source checkout, after `npm ci && npm run build`):
//   node scripts/flagship-demo.mjs               print the walkthrough, then clean up
//   node scripts/flagship-demo.mjs --keep        keep the disposable copy and print its path
//   node scripts/flagship-demo.mjs --write-site  also regenerate site/demo-data.js

/* global console, process */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE_NAME = 'lending-desk';
export const SAMPLE_DIR = join(REPO_ROOT, 'examples', SAMPLE_NAME);
export const SITE_DATA_PATH = join(REPO_ROOT, 'site', 'demo-data.js');
export const TEMP_PREFIX = 'archmap-demo-';

const EDIT_PATH = 'src/loans/policy.ts';
const EDIT_BEFORE = 'export const LOAN_DAYS = 14;';
const EDIT_AFTER = 'export const LOAN_DAYS = 21;';
/** Placeholder for the random project id `archmap init` generates, so the record is stable. */
const PROJECT_ID_PLACEHOLDER = 'proj_<random-at-init>';
/** Placeholder for the disposable copy's absolute path. */
const ROOT_PLACEHOLDER = '<disposable-copy>';

const DEFAULT_CLI = [process.execPath, join(REPO_ROOT, 'dist', 'cli', 'bin.js')];

// Fixed identity and timestamps make the sample's commit SHAs, and therefore every recorded
// evidence pointer, identical on every machine.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'ArchMap Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'ArchMap Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.invalid',
};
const SAMPLE_COMMIT_DATE = '2026-01-05T09:00:00Z';
const EDIT_COMMIT_DATE = '2026-01-12T09:00:00Z';

/**
 * Environment for every child process: no inherited GIT_* variables (a caller's GIT_DIR must
 * never redirect writes into another repository) and no user/system Git configuration (hooks,
 * signing, or fsmonitor settings must not change behaviour or output).
 */
function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...GIT_IDENTITY,
    ...extra,
  };
}

function git(cwd, args, extraEnv) {
  const res = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv(extraEnv),
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

function commitAll(cwd, message, date) {
  git(cwd, ['add', '-A', '--', '.', ':(exclude).archmap']);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** Real paths of the directories this process created; nothing else is ever removed. */
const createdByThisProcess = new Set();

/**
 * Create the disposable workspace: `<os tmp>/archmap-demo-XXXXXX/lending-desk`. The nested
 * directory keeps the project name (derived from the directory name) stable.
 */
export function createDisposableCopy() {
  const owned = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
  createdByThisProcess.add(owned);
  const root = join(owned, SAMPLE_NAME);
  try {
    cpSync(SAMPLE_DIR, root, {
      recursive: true,
      filter: (src) => !['.archmap', '.git', 'node_modules'].includes(basename(src)),
    });
  } catch (err) {
    removeOwnedCopy(owned);
    throw err;
  }
  return { owned, root };
}

/**
 * Remove a directory only if this process created it with createDisposableCopy. A look-alike
 * `archmap-demo-*` directory created by anything else is refused.
 */
export function removeOwnedCopy(owned) {
  const real = existsSync(owned) ? realpathSync(owned) : owned;
  if (!createdByThisProcess.has(real)) {
    throw new Error(`refusing to remove ${owned}: not a demo directory created by this process`);
  }
  rmSync(real, { recursive: true, force: true });
  createdByThisProcess.delete(real);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.archmap') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

function readNodes(root) {
  const dir = join(root, '.archmap', 'nodes');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), 'utf8')));
}

/**
 * Run the full maintenance loop against `root` with the real CLI. Returns the recorded steps,
 * the sample source (before and after the edit), and the tracked graph from both scans.
 */
export function runWalkthrough(root, { cli = DEFAULT_CLI, log = () => {} } = {}) {
  const steps = [];
  const run = (id, title, args, note) => {
    const [cmd, ...pre] = cli;
    const res = spawnSync(cmd, [...pre, ...args], { cwd: root, encoding: 'utf8', env: isolatedEnv() });
    if (res.error) throw res.error;
    let output;
    try {
      output = JSON.parse(res.stdout);
    } catch {
      throw new Error(`archmap ${args.join(' ')} did not print JSON (exit ${res.status}): ${res.stderr}`);
    }
    const step = { id, title, command: `archmap ${args.join(' ')}`, exit_code: res.status, note, output };
    steps.push(step);
    log(step);
    return output;
  };
  const action = (id, title, command, note, output) => {
    const step = { id, title, command, exit_code: 0, note, output };
    steps.push(step);
    log(step);
  };

  // A fresh repository rooted exactly at the copy; never operate inside an enclosing one.
  git(root, ['init', '-q']);
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== realpathSync(root)) {
    throw new Error(`${root} is not the top level of its own Git repository`);
  }
  const sampleCommit = commitAll(root, 'Add lending-desk sample', SAMPLE_COMMIT_DATE);
  const sourceBefore = listFiles(root).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

  run('init', 'Initialize', ['init', '--json'], 'Creates .archmap/project.yaml at the Git top level of the working directory.');
  run('scan', 'Scan', ['scan', '--json'], 'Deterministic analyzers write reviewable YAML: a snapshot plus one file per node.');
  const graphBefore = readNodes(root);
  run('status-clean', 'Status', ['status', '--json'], 'The working tree matches the snapshot, so nothing is stale.');
  run('context', 'Context', ['context', EDIT_PATH, '--json'], 'The smallest evidence-backed context for a file, within an estimated token budget.');
  const impact = run('impact', 'Impact', ['impact', EDIT_PATH, '--json'], 'Everything that scopes or transitively imports the file.');

  const idOf = (title) => {
    const hit = impact.impacted.find((e) => e.title === title);
    if (!hit) throw new Error(`impact result has no node titled ${title}`);
    return hit.id;
  };
  run('evidence', 'Evidence', ['evidence', idOf('src/loans/service.ts'), '--json'],
    'Source pointers for the service module: path, symbol, blob hash, commit, analyzer.');
  run('evidence-partial', 'Partial evidence', ['evidence', idOf('src/http/routes.ts'), '--json'],
    'Route registrations are heuristic, so their relations are recorded as partial.');

  const policyPath = join(root, EDIT_PATH);
  const policy = readFileSync(policyPath, 'utf8');
  if (!policy.includes(EDIT_BEFORE)) throw new Error(`sample ${EDIT_PATH} no longer contains "${EDIT_BEFORE}"`);
  writeFileSync(policyPath, policy.replace(EDIT_BEFORE, EDIT_AFTER));
  action('edit', 'Edit source', `edit ${EDIT_PATH}`, 'Extend the loan period from 14 to 21 days.', {
    path: EDIT_PATH,
    before: EDIT_BEFORE,
    after: EDIT_AFTER,
  });

  run('status-stale', 'Status after edit', ['status', '--json'], 'The snapshot no longer matches: the edited file and the nodes that scope it are stale.');
  run('impact-base', 'Impact from Git', ['impact', '--base', 'HEAD', '--json'], 'The changed-file set can also come from git diff.');
  const editCommit = commitAll(root, 'Extend loan period to 21 days', EDIT_COMMIT_DATE);
  action('commit', 'Commit edit', 'git commit -am "Extend loan period to 21 days"', 'The source change is committed; the map is now behind HEAD.', {
    commit: editCommit,
  });
  run('rescan', 'Rescan', ['scan', '--json'], 'Rescanning refreshes the snapshot and the affected nodes.');
  run('status-fresh', 'Status after rescan', ['status', '--json'], 'Clean again at the new commit.');
  const graphAfter = readNodes(root);

  return { sampleCommit, editCommit, sourceBefore, steps, graphBefore, graphAfter };
}

/** Replace machine-specific values so the record contains no local paths or random ids. */
export function sanitize(value, root) {
  const home = homedir();
  const needles = [...new Set([root, realpathSync(root), ...(home.length > 1 ? [home] : [])])].sort(
    (a, b) => b.length - a.length,
  );
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v;
      for (const n of needles) s = s.split(n).join(n === home ? '~' : ROOT_PLACEHOLDER);
      return s.replace(/^proj_[0-9a-f]{12}$/, PROJECT_ID_PLACEHOLDER);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

export function buildRecord(result, root) {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return sanitize(
    {
      schema_version: 1,
      kind: 'archmap-recorded-demo',
      recorded: true,
      synthetic: true,
      archmap_version: pkg.version,
      sample: `examples/${SAMPLE_NAME}`,
      generator: 'node scripts/flagship-demo.mjs --write-site',
      sanitization: [
        `The disposable copy's absolute path is replaced with ${ROOT_PLACEHOLDER}.`,
        `The random project id from init is replaced with ${PROJECT_ID_PLACEHOLDER}.`,
        'Commits use a fixed demo identity and fixed dates, so SHAs are reproducible.',
      ],
      commits: { sample: result.sampleCommit, edit: result.editCommit },
      files: result.sourceBefore,
      steps: result.steps,
      graph: { before: result.graphBefore, after: result.graphAfter },
    },
    root,
  );
}

export function renderSiteData(record) {
  return (
    '// Generated by `node scripts/flagship-demo.mjs --write-site`. Do not edit by hand.\n' +
    '// A recorded run of the real ArchMap CLI on the synthetic examples/lending-desk sample.\n' +
    '/* global window */\n' +
    `window.ARCHMAP_DEMO = ${JSON.stringify(record, null, 2)};\n`
  );
}

function summarize(step) {
  const o = step.output;
  switch (step.id) {
    case 'scan':
    case 'rescan':
      return `${o.files} files -> ${o.nodes} nodes at ${String(o.base_commit).slice(0, 7)}`;
    case 'status-clean':
    case 'status-stale':
    case 'status-fresh':
      return o.clean ? 'clean' : `stale: ${o.diff.modified.join(', ')} -> ${o.stale_nodes.length} stale node(s)`;
    case 'context':
      return `${o.included.length} node(s), ${o.used_tokens}/${o.budget} tokens`;
    case 'impact':
    case 'impact-base':
      return `${o.impacted.length} node(s): ${o.impacted.map((e) => e.title).join(', ')}`;
    case 'evidence':
    case 'evidence-partial':
      return `${o.evidence.length} evidence pointer(s)`;
    case 'edit':
      return `${o.before}  ->  ${o.after}`;
    case 'commit':
      return o.commit.slice(0, 7);
    default:
      return '';
  }
}

function main(argv) {
  const known = new Set(['--keep', '--write-site']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    console.error(`unknown option(s): ${unknown.join(' ')}\nusage: node scripts/flagship-demo.mjs [--keep] [--write-site]`);
    return 2;
  }
  if (!existsSync(DEFAULT_CLI[1])) {
    console.error('dist/cli/bin.js not found; run `npm ci && npm run build` first');
    return 2;
  }

  const { owned, root } = createDisposableCopy();
  let ok = false;
  try {
    console.log(`Disposable copy of examples/${SAMPLE_NAME}: ${root}\n`);
    const result = runWalkthrough(root, {
      log: (s) => console.log(`$ ${s.command}\n  exit ${s.exit_code} · ${summarize(s)}\n`),
    });
    if (argv.includes('--write-site')) {
      writeFileSync(SITE_DATA_PATH, renderSiteData(buildRecord(result, root)));
      console.log(`Wrote ${relative(REPO_ROOT, SITE_DATA_PATH)}`);
    }
    ok = true;
  } finally {
    if (argv.includes('--keep')) console.log(`Kept ${root}; remove ${owned} when done.`);
    else removeOwnedCopy(owned);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
