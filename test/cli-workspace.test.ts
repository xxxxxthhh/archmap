import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import { runWorkspaceCommand } from '../src/cli/workspace-command.js';
import type { ProjectConfig } from '../src/scan/types.js';
import { writeProject } from '../src/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'src', 'cli', 'bin.ts');
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let workspace: string;
const ctx = () => ({ cwd: workspace });
const cachePath = () => join(workspace, '.archmap', 'cache', 'workspace-index.json');

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function trackedBytes(root: string): Array<[string, string]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  return files.sort().map((path) => [relative(root, path), readFileSync(path).toString('base64')]);
}

function initializeProject(root: string, id: string, sourcePath: string, source: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  write(root, sourcePath, source);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  expect(runInit([], { cwd: root }).exitCode).toBe(0);
  const config: ProjectConfig = {
    schema_version: 1,
    project: { id, name: `${id}-project` },
    scan: { max_file_bytes: 1_000_000, exclude_dirs: [], secret_globs: [] },
  };
  writeProject(root, config);
  expect(runScanCommand([], { cwd: root }).exitCode).toBe(0);
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-workspace-')));
  git(workspace, 'init');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'config', 'user.name', 'Test');
  write(workspace, 'README.md', '# workspace\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-m', 'workspace');
  expect(runInit([], ctx()).exitCode).toBe(0);
  expect(runScanCommand([], ctx()).exitCode).toBe(0);

  initializeProject(
    join(workspace, 'services', 'api'),
    'api',
    'src/api.ts',
    'export const api = true;\n',
  );
  initializeProject(
    join(workspace, 'sites', 'docs'),
    'docs',
    'content/intro.md',
    '# Intro\n\nA documentation fixture.\n',
  );
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('archmap workspace index', () => {
  it('writes a deterministic aggregate without mutating member repositories', () => {
    const api = join(workspace, 'services', 'api');
    const docs = join(workspace, 'sites', 'docs');
    const before = [trackedBytes(api), trackedBytes(docs)];

    const first = runWorkspaceCommand(['index', 'sites/docs', 'services/api', '--json'], ctx());
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    const report = JSON.parse(first.stdout) as {
      schema_version: number;
      command: string;
      summary: { member_count: number; node_count: number };
      members: Array<{
        path: string;
        project_id: string;
        project_name: string;
        node_count: number;
        snapshot_identity: string;
        dirty: boolean;
      }>;
    };
    expect(report).toMatchObject({
      schema_version: 1,
      command: 'workspace index',
      summary: { member_count: 2 },
    });
    expect(report.summary.node_count).toBeGreaterThan(0);
    expect(report.members.map((member) => member.path)).toEqual(['services/api', 'sites/docs']);
    expect(report.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'services/api',
        project_id: 'api',
        project_name: 'api-project',
        node_count: expect.any(Number),
        snapshot_identity: expect.stringMatching(/^sha256:/),
        dirty: false,
      }),
      expect.objectContaining({ path: 'sites/docs', project_id: 'docs', project_name: 'docs-project' }),
    ]));
    const firstCache = readFileSync(cachePath(), 'utf8');
    expect(firstCache).toBe(first.stdout);

    const markdown = runWorkspaceCommand(['index', 'services/api', 'sites/docs'], ctx());
    expect(markdown.exitCode).toBe(0);
    expect(markdown.stdout).toContain('# Archmap workspace index');
    expect(markdown.stdout).toContain(JSON.stringify('services/api'));
    expect(markdown.stdout).toContain(JSON.stringify('sites/docs'));

    rmSync(cachePath());
    const rebuilt = runWorkspaceCommand(['index', 'services/api', 'sites/docs', '--json'], ctx());
    expect(rebuilt.exitCode).toBe(0);
    expect(rebuilt.stdout).toBe(first.stdout);
    expect(readFileSync(cachePath(), 'utf8')).toBe(firstCache);
    expect([trackedBytes(api), trackedBytes(docs)]).toEqual(before);

    write(api, 'src/new.ts', 'export const newer = true;\n');
    git(api, 'add', '-A');
    git(api, 'commit', '-m', 'new member baseline');
    expect(runScanCommand([], { cwd: api }).exitCode).toBe(0);
    const refreshed = JSON.parse(
      runWorkspaceCommand(['index', 'services/api', 'sites/docs', '--json'], ctx()).stdout,
    ) as { members: Array<{ path: string; snapshot_identity: string; node_count: number }> };
    const initialApi = report.members.find((member) => member.path === 'services/api')!;
    const refreshedApi = refreshed.members.find((member) => member.path === 'services/api')!;
    expect(refreshedApi.snapshot_identity).not.toBe(initialApi.snapshot_identity);
    expect(refreshedApi.node_count).toBeGreaterThan(initialApi.node_count);
  });

  it('rejects unsafe or invalid members before changing an existing aggregate cache', () => {
    expect(runWorkspaceCommand(['index', 'services/api', 'sites/docs', '--json'], ctx()).exitCode).toBe(0);
    const beforeCache = readFileSync(cachePath(), 'utf8');
    const api = join(workspace, 'services', 'api');
    const beforeMember = trackedBytes(api);
    const duplicate = join(workspace, 'services', 'duplicate');
    initializeProject(duplicate, 'api', 'src/duplicate.ts', 'export const duplicate = true;\n');
    symlinkSync(api, join(workspace, 'linked-api'));

    for (const args of [
      ['index', '--json'],
      ['index', '../outside', '--json'],
      ['index', 'missing', '--json'],
      ['index', 'services/api', 'services/api', '--json'],
      ['index', 'linked-api', '--json'],
      ['index', 'services/api', 'services/duplicate', '--json'],
    ]) {
      const out = runWorkspaceCommand(args, ctx());
      expect(out.exitCode).toBe(2);
      expect(out.stdout).toBe('');
      expect(JSON.parse(out.stderr).error).toBeTruthy();
      expect(readFileSync(cachePath(), 'utf8')).toBe(beforeCache);
    }
    expect(trackedBytes(api)).toEqual(beforeMember);
  });

  it('keeps model-derived Markdown values inert when a project name contains backticks', () => {
    const docs = join(workspace, 'sites', 'docs');
    writeProject(docs, {
      schema_version: 1,
      project: { id: 'docs', name: 'docs`<script>' },
      scan: { max_file_bytes: 1_000_000, exclude_dirs: [], secret_globs: [] },
    });

    const out = runWorkspaceCommand(['index', 'services/api', 'sites/docs'], ctx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('``"docs`<script>"``');
  });

  it('dispatches the same JSON aggregate through the real CLI binary', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', TSX_IMPORT, BIN, 'workspace', 'index', 'services/api', 'sites/docs', '--json'],
      { cwd: workspace, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 1,
      command: 'workspace index',
      summary: { member_count: 2 },
    });
  }, 15_000);
});
