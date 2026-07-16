import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectureDiff } from '../src/diff/diff.js';
import type { Scope } from '../src/model/types.js';
import { neutralizeText } from '../src/render/sanitize.js';
import { CONTENT_SECURITY_POLICY } from '../src/serve/content-safety.js';
import { startViewerServer, type RunningViewer } from '../src/serve/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'viewer-diff-repo');
const running: RunningViewer[] = [];
const repositories: string[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close().catch(() => {});
  while (repositories.length > 0) rmSync(repositories.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

function writeFixtureState(root: string, state: 'base' | 'head'): void {
  rmSync(join(root, '.archmap'), { recursive: true, force: true });
  cpSync(join(FIXTURE, state, '.archmap'), join(root, '.archmap'), { recursive: true });
}

function commitFixtureState(root: string, state: 'base' | 'head', date: string): string {
  writeFixtureState(root, state);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', `viewer diff ${state}`], {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(root, ['rev-parse', 'HEAD']);
}

function prepareRepository(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'archmap-viewer-diff-'));
  repositories.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Viewer Diff Fixture']);
  const base = commitFixtureState(root, 'base', '2026-07-16T00:00:00Z');
  const head = commitFixtureState(root, 'head', '2026-07-16T00:01:00Z');
  return { root, base, head };
}

async function start(cwd: string): Promise<RunningViewer> {
  const viewer = await startViewerServer({ cwd, port: 0 });
  running.push(viewer);
  return viewer;
}

function endpoint(viewer: RunningViewer, base: string, head: string): string {
  return `${viewer.url}api/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
}

function viewerReport(report: ReturnType<typeof architectureDiff>): ReturnType<typeof architectureDiff> {
  const scope = (value: Scope): Scope => ({
    ...(value.files ? { files: value.files.map((file) => neutralizeText(file)) } : {}),
    ...(value.symbols ? { symbols: value.symbols.map((symbol) => neutralizeText(symbol)) } : {}),
  });
  const node = (entry: ReturnType<typeof architectureDiff>['nodes']['added'][number]) => ({
    ...entry,
    title: neutralizeText(entry.title),
    ...(entry.scope ? { scope: scope(entry.scope) } : {}),
  });
  const claim = (entry: ReturnType<typeof architectureDiff>['claims']['added'][number]) => ({
    ...entry,
    text: neutralizeText(entry.text),
  });
  return {
    ...report,
    nodes: {
      added: report.nodes.added.map(node),
      removed: report.nodes.removed.map(node),
      changed: report.nodes.changed.map((entry) => ({ before: node(entry.before), after: node(entry.after) })),
    },
    claims: {
      added: report.claims.added.map(claim),
      removed: report.claims.removed.map(claim),
      changed: report.claims.changed.map((entry) => ({ before: claim(entry.before), after: claim(entry.after) })),
      stale: report.claims.stale.map(claim),
    },
  };
}

describe('M5 viewer diff exit', () => {
  it('serves the V2 bucket report, including every node, relation, and claim bucket', async () => {
    const repository = prepareRepository();
    const viewer = await start(repository.root);

    const response = await fetch(endpoint(viewer, repository.base, repository.head));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);

    const body = (await response.json()) as ReturnType<typeof architectureDiff> & { identical: boolean };
    expect(body).toEqual({
      ...viewerReport(architectureDiff(repository.root, repository.base, repository.head)),
      identical: false,
    });
    expect(body.nodes.added.map((node) => node.id)).toEqual(['node_added']);
    expect(body.nodes.removed.map((node) => node.id)).toEqual(['node_removed']);
    expect(body.nodes.changed.map((change) => change.after.id)).toEqual(['node_changed']);
    expect(body.relations.added.map((relation) => relation.id)).toEqual(['rel_added']);
    expect(body.relations.removed.map((relation) => relation.id)).toEqual(['rel_removed']);
    expect(body.relations.changed.map((change) => change.after.id)).toEqual(['rel_changed']);
    expect(body.claims.added.map((claim) => claim.id)).toEqual(['claim_added']);
    expect(body.claims.added[0]).toMatchObject({ type: 'inference', status: 'active' });
    expect(body.claims.stale.map((claim) => claim.id)).toEqual(['claim_stale']);
    expect(body.claims.stale[0]).toMatchObject({ type: 'inference', status: 'stale' });
    expect(git(repository.root, ['status', '--porcelain'])).toBe('');
  });

  it('neutralizes hostile diff display text without changing V2 membership, certainty, or status', async () => {
    const repository = prepareRepository();
    const changedNode = join(repository.root, '.archmap', 'nodes', 'node_changed.yaml');
    writeFileSync(
      changedNode,
      readFileSync(changedNode, 'utf8').replace(
        'title: After title',
        [
          'title: "<img src=x onerror=window.__diffTitle=1>"',
          'scope:',
          '  files:',
          '    - "src/app/main.ts"',
          '    - "<img src=x onerror=window.__diffScopeFile=1>.ts"',
          '    - "src/render/long-name.ts"',
          '  symbols:',
          '    - "Component.render"',
          '    - "<svg onload=window.__diffScopeSymbol=1>"',
          '    - "parseInput"',
        ].join('\n'),
      ),
    );
    git(repository.root, ['add', '-A']);
    git(repository.root, ['commit', '--quiet', '-m', 'hostile diff display']);
    const hostileHead = git(repository.root, ['rev-parse', 'HEAD']);
    const engine = architectureDiff(repository.root, repository.base, hostileHead);
    expect(JSON.stringify(engine)).toContain('<img src=x onerror=window.__diffTitle=1>');
    expect(JSON.stringify(engine)).toContain('<img src=x onerror=window.__diffScopeFile=1>.ts');
    expect(JSON.stringify(engine)).toContain('<svg onload=window.__diffScopeSymbol=1>');
    expect(JSON.stringify(engine)).toContain('<script>window.__diffClaim=1</script>');

    const viewer = await start(repository.root);
    const response = await fetch(endpoint(viewer, repository.base, hostileHead));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReturnType<typeof architectureDiff> & { identical: boolean };
    expect(body).toEqual({ ...viewerReport(engine), identical: false });
    expect(JSON.stringify(body)).not.toContain('<img');
    expect(JSON.stringify(body)).not.toContain('<svg');
    expect(JSON.stringify(body)).not.toContain('<script');
    const changedScope = engine.nodes.changed[0]!.after.scope!;
    expect(changedScope).toEqual({
      files: ['src/app/main.ts', '<img src=x onerror=window.__diffScopeFile=1>.ts', 'src/render/long-name.ts'],
      symbols: ['Component.render', '<svg onload=window.__diffScopeSymbol=1>', 'parseInput'],
    });
    expect(body.nodes.changed[0]!.after.scope).toEqual({
      files: [
        'src/app/main.ts',
        neutralizeText('<img src=x onerror=window.__diffScopeFile=1>.ts'),
        'src/render/long-name.ts',
      ],
      symbols: [
        'Component.render',
        neutralizeText('<svg onload=window.__diffScopeSymbol=1>'),
        'parseInput',
      ],
    });
    expect(body.relations).toEqual(engine.relations);
    expect(body.claims.added[0]).toMatchObject({ id: 'claim_added', type: 'inference', status: 'active' });
    expect(body.claims.stale[0]).toMatchObject({ id: 'claim_stale', type: 'inference', status: 'stale' });
    expect(git(repository.root, ['status', '--porcelain'])).toBe('');
  });

  it('marks two refs resolving to the same commit as an explicit empty state', async () => {
    const repository = prepareRepository();
    const viewer = await start(repository.root);

    const response = await fetch(endpoint(viewer, repository.base, repository.base));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReturnType<typeof architectureDiff> & { identical: boolean };
    expect(body).toEqual({
      ...architectureDiff(repository.root, repository.base, repository.base),
      identical: true,
    });
    expect(body.nodes).toEqual({ added: [], removed: [], changed: [] });
    expect(body.relations).toEqual({ added: [], removed: [], changed: [] });
  });

  it('rejects missing, duplicated, unsafe, and non-GET requests before any write', async () => {
    const repository = prepareRepository();
    const viewer = await start(repository.root);
    const valid = `base=${encodeURIComponent(repository.base)}&head=${encodeURIComponent(repository.head)}`;
    const requests = [
      `${viewer.url}api/diff`,
      `${viewer.url}api/diff?base=${encodeURIComponent(repository.base)}`,
      `${viewer.url}api/diff?${valid}&base=${encodeURIComponent(repository.base)}`,
      `${viewer.url}api/diff?base=${encodeURIComponent('--upload-pack=touch pwned')}&head=${encodeURIComponent(repository.head)}`,
      `${viewer.url}api/diff?base=%00&head=${encodeURIComponent(repository.head)}`,
    ];

    for (const url of requests) {
      const response = await fetch(url);
      expect(response.status, url).toBe(400);
      expect(response.headers.get('content-security-policy'), url).toBe(CONTENT_SECURITY_POLICY);
      expect(await response.json(), url).toEqual(expect.objectContaining({ error: expect.any(String) }));
    }

    const writeAttempt = await fetch(`${viewer.url}api/diff?${valid}`, { method: 'POST' });
    expect(writeAttempt.status).toBe(405);
    expect(writeAttempt.headers.get('allow')).toBe('GET');
    expect(writeAttempt.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(git(repository.root, ['status', '--porcelain'])).toBe('');
  });
});
