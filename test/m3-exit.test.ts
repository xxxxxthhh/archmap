import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { toCanonicalJson } from '../src/model/canonical.js';
import type { Evidence, Manifest, Node } from '../src/model/types.js';
import { discover } from '../src/scan/discover.js';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SECRET_GLOBS,
} from '../src/scan/exclude.js';
import { prospectiveModel } from '../src/scan/projection.js';
import type { ProjectConfig, Snapshot } from '../src/scan/types.js';
import { validateManifest } from '../src/validate/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..');
const fixtureRoot = join(sourceRoot, 'fixtures', 'mixed-repo');
const goldenPath = join(fixtureRoot, 'golden.manifest.json');
const compiledBin = join(sourceRoot, 'dist', 'cli', 'bin.js');
const scanConfig: ProjectConfig['scan'] = {
  max_file_bytes: DEFAULT_MAX_FILE_BYTES,
  exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
  secret_globs: [...DEFAULT_SECRET_GLOBS],
};
const fixedGitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ArchMap Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'ArchMap Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

interface ScannedModel {
  snapshot: Snapshot;
  manifest: Manifest;
}

const temporaryRoots: string[] = [];

function copyFixture(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'golden.manifest.json') continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyFixture(source, target);
    else copyFileSync(source, target);
  }
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: fixedGitEnvironment });
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [compiledBin, ...args], { cwd, encoding: 'utf8' });
}

function expectSuccess(cwd: string, args: string[]): ReturnType<typeof run> {
  const result = run(cwd, args);
  expect(result.status, `${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  return result;
}

function prepareRepository(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'archmap-m3-exit-'));
  temporaryRoots.push(temporaryRoot);
  const repository = join(temporaryRoot, 'mixed-repo');
  copyFixture(fixtureRoot, repository);
  expect(git(repository, ['init']).status).toBe(0);
  expect(git(repository, ['add', '-A']).status).toBe(0);
  expect(git(repository, ['commit', '-m', 'fixture']).status).toBe(0);
  expectSuccess(repository, ['init']);
  expectSuccess(repository, ['scan']);
  return repository;
}

function readModel(repository: string): ScannedModel {
  const snapshot = parseYaml(readFileSync(join(repository, '.archmap', 'snapshot.yaml'), 'utf8')) as Snapshot;
  const nodeDirectory = join(repository, '.archmap', 'nodes');
  const nodes = readdirSync(nodeDirectory)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const document = parseYaml(readFileSync(join(nodeDirectory, name), 'utf8')) as Node & { schema_version?: number };
      delete document.schema_version;
      return document;
    });
  return {
    snapshot,
    manifest: { schema_version: 1, capabilities: snapshot.capabilities, nodes },
  };
}

function trackedBytes(repository: string): string {
  const nodeDirectory = join(repository, '.archmap', 'nodes');
  return [
    readFileSync(join(repository, '.archmap', 'snapshot.yaml'), 'utf8'),
    ...readdirSync(nodeDirectory)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
      .map((name) => `${name}\n${readFileSync(join(nodeDirectory, name), 'utf8')}`),
  ].join('\n---\n');
}

function evidenceIn(nodes: Node[]): Evidence[] {
  return nodes.flatMap((node) => [
    ...node.claims.flatMap((claim) => claim.evidence),
    ...node.relations.flatMap((relation) => relation.evidence ?? []),
  ]);
}

function nodeForPath(nodes: Node[], path: string): Node {
  const node = nodes.find((candidate) =>
    candidate.scope?.files?.length === 1 && candidate.scope.files[0] === path &&
    (candidate.title === path || candidate.kind === 'store'));
  if (!node) throw new Error(`missing per-file node for ${path}`);
  return node;
}

function canonicalGolden(manifest: Manifest): string {
  const normalized = structuredClone(manifest);
  const normalizeVersion = (version: string): string =>
    version.replace(/^(0\.2\.0)\+python-\d+\.\d+$/, '$1+python-runtime');
  for (const capability of normalized.capabilities) {
    if (capability.id === 'python') capability.version = normalizeVersion(capability.version);
  }
  for (const evidence of evidenceIn(normalized.nodes)) {
    if (evidence.analyzer === 'python') evidence.analyzer_version = normalizeVersion(evidence.analyzer_version);
  }
  return toCanonicalJson(normalized);
}

function canonicalNodeIgnoringCommit(node: Node): string {
  const normalized = structuredClone(node);
  for (const evidence of evidenceIn([normalized])) evidence.commit = '<evidence-identity>';
  return toCanonicalJson(normalized);
}

function assertManifestInvariants(model: ScannedModel): void {
  expect(validateManifest(model.manifest)).toEqual({ valid: true, errors: [] });
  const ids = new Set(model.manifest.nodes.map((node) => node.id));
  expect(ids.size).toBe(model.manifest.nodes.length);
  const capabilityByAnalyzer = new Map(model.manifest.capabilities.map((capability) => [capability.id, capability]));

  for (const node of model.manifest.nodes) {
    for (const claim of node.claims) {
      expect(claim.provenance.actor).toBe('analyzer');
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
    for (const relation of node.relations) {
      expect(ids.has(relation.target), `${node.title} -> ${relation.target}`).toBe(true);
      expect(relation.provenance?.actor).toBe('analyzer');
      expect(relation.evidence?.length ?? 0).toBeGreaterThan(0);
    }
  }
  for (const evidence of evidenceIn(model.manifest.nodes)) {
    expect(capabilityByAnalyzer.get(evidence.analyzer)?.version).toBe(evidence.analyzer_version);
  }
}

beforeAll(() => {
  const build = spawnSync('npm', ['run', 'build', '--silent'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  });
  expect(build.status, `compiled CLI build failed\n${build.stdout}\n${build.stderr}`).toBe(0);
}, 30_000);

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('M3 compiled mixed-repository exit fixture', () => {
  it('matches its complete canonical golden and is byte-stable on unchanged scans', async () => {
    const repository = prepareRepository();
    const first = readModel(repository);
    const head = git(repository, ['rev-parse', 'HEAD']).stdout.trim();

    expect(first.snapshot.dirty).toBe(false);
    expect(first.snapshot.base_commit).toBe(head);
    expect(evidenceIn(first.manifest.nodes).every((evidence) => evidence.commit === head)).toBe(true);
    assertManifestInvariants(first);

    const manifestPath = join(dirname(repository), 'complete-manifest.json');
    writeFileSync(manifestPath, toCanonicalJson(first.manifest));
    expectSuccess(repository, ['validate', manifestPath, '--json']);

    const firstCanonical = canonicalGolden(first.manifest);
    await expect(firstCanonical).toMatchFileSnapshot(goldenPath);
    const before = trackedBytes(repository);

    expectSuccess(repository, ['scan']);
    expect(trackedBytes(repository)).toBe(before);
    const secondCanonical = canonicalGolden(readModel(repository).manifest);
    expect(secondCanonical).toBe(firstCanonical);
    await expect(secondCanonical).toMatchFileSnapshot(goldenPath);

    const changed = JSON.parse(expectSuccess(repository, ['scan', '--changed', '--json']).stdout) as {
      changed: boolean;
      wrote: boolean;
    };
    expect(changed).toEqual(expect.objectContaining({ changed: false, wrote: false }));
    const status = JSON.parse(expectSuccess(repository, ['status', '--json']).stdout) as { clean: boolean };
    expect(status.clean).toBe(true);
    expect(git(repository, ['diff', '--quiet', '--', '.', ':(exclude).archmap']).status).toBe(0);
  }, 30_000);

  it('composes cross-adapter context, incoming impact, evidence navigation, and external identity', () => {
    const repository = prepareRepository();
    const model = readModel(repository);
    const nodes = model.manifest.nodes;
    assertManifestInvariants(model);

    const guide = nodeForPath(nodes, 'docs/README.md');
    const transform = nodeForPath(nodes, 'pipeline/transform.py');
    const source = nodeForPath(nodes, 'data/source.yaml');
    const cli = nodeForPath(nodes, 'pipeline/cli.py');
    const api = nodeForPath(nodes, 'pipeline/api.py');
    const testModule = nodeForPath(nodes, 'tests/test_transform.py');
    const decision = nodeForPath(nodes, 'docs/decisions/ADR-0001.md');
    const ledger = nodeForPath(nodes, 'docs/ledger/2026.md');
    const byId = new Map(nodes.map((node) => [node.id, node]));

    expect(transform.scope?.symbols).toEqual(expect.arrayContaining(['build_report', 'dynamic_target']));
    expect(cli.claims.some((claim) => claim.text.includes('Entry point'))).toBe(true);
    expect(testModule.claims.some((claim) => claim.text.includes('Pytest'))).toBe(true);
    expect(testModule.relations.some((relation) => relation.type === 'imports' && relation.target === transform.id)).toBe(true);
    const publicationTitles = [...cli.relations, ...api.relations]
      .filter((relation) => relation.type === 'publishes' && relation.certainty === 'partial')
      .map((relation) => byId.get(relation.target)?.title);
    expect(publicationTitles).toEqual(expect.arrayContaining([
      'cli:build',
      'route:GET /health',
      'route:POST /reports',
    ]));
    expect(decision.claims.some((claim) => claim.text.includes('Decision record'))).toBe(true);
    expect(ledger.claims.some((claim) => claim.text.includes('Ledger asset'))).toBe(true);
    expect(source.claims.some((claim) => claim.text.includes('Top-level keys'))).toBe(true);
    expect(guide.relations.some((relation) => relation.target === transform.id && relation.certainty === 'known')).toBe(true);
    expect(guide.relations.some((relation) => relation.target === source.id && relation.certainty === 'known')).toBe(true);

    const context = JSON.parse(expectSuccess(repository, [
      'context', 'docs/README.md', '--budget', '100000', '--json',
    ]).stdout) as {
      budget: number;
      used_tokens: number;
      included: Array<{ reason: string; node: Node }>;
    };
    expect(context.used_tokens).toBeLessThanOrEqual(context.budget);
    const contextById = new Map(context.included.map((entry) => [entry.node.id, entry.reason]));
    expect(contextById.get(guide.id)).toContain('target');
    expect(contextById.get(transform.id)).toContain('referenced by');
    expect(contextById.get(source.id)).toContain('referenced by');
    expect(context.included.some((entry) => entry.reason.includes('parent view') && entry.node.title === 'docs')).toBe(true);
    expect(context.included.some((entry) => entry.reason.includes('repository root') && entry.node.kind === 'system')).toBe(true);

    const impact = JSON.parse(expectSuccess(repository, ['impact', 'data/output.json', '--json']).stdout) as {
      impacted: Array<{ title: string; reason: string }>;
    };
    const impactedTitles = new Set(impact.impacted.map((entry) => entry.title));
    expect(impactedTitles.has('pipeline/transform.py')).toBe(true);
    expect(impactedTitles.has('M3 report')).toBe(true);
    expect(impactedTitles.has('2026 run ledger')).toBe(true);
    expect(impact.impacted.some((entry) => entry.reason.includes('repository root'))).toBe(true);

    for (const target of nodes.flatMap((node) => [
      ...node.claims.map((claim) => claim.id),
      ...node.relations.map((relation) => relation.id),
    ])) {
      const evidence = JSON.parse(expectSuccess(repository, ['evidence', target, '--json']).stdout) as {
        found: boolean;
        evidence: Evidence[];
      };
      expect(evidence.found, target).toBe(true);
      expect(evidence.evidence.length, target).toBeGreaterThan(0);
    }

    const requestsNodes = nodes.filter((node) => node.kind === 'external' && node.title === 'requests');
    expect(requestsNodes).toHaveLength(1);
    expect(nodes.flatMap((node) => node.relations).filter((relation) => relation.target === requestsNodes[0]!.id).length)
      .toBeGreaterThanOrEqual(2);
    const operationsNodes = nodes.filter((node) =>
      node.kind === 'external' && node.title === 'https://example.com/operations');
    expect(operationsNodes).toHaveLength(1);
    expect(nodes.flatMap((node) => node.relations).filter((relation) => relation.target === operationsNodes[0]!.id).length)
      .toBeGreaterThanOrEqual(2);

    const uncertain = nodes.flatMap((node) => node.relations).filter((relation) =>
      relation.type === 'publishes' || relation.type === 'reads' || relation.type === 'writes');
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.every((relation) => relation.certainty === 'partial')).toBe(true);
  }, 90_000);

  it.each([
    {
      label: 'Python',
      path: 'pipeline/transform.py',
      mutate: (path: string) => appendFileSync(path, '\n\ndef audit_marker() -> bool:\n    return True\n'),
    },
    {
      label: 'Markdown',
      path: 'docs/README.md',
      mutate: (path: string) => appendFileSync(path, '\n## Audit trail\n\nThe fixture remains deterministic.\n'),
    },
    {
      label: 'YAML/JSON',
      path: 'data/output.json',
      mutate: (path: string) => {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        value.audited = true;
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    },
  ])('isolates a dirty $label update to its per-file model slice', ({ path, mutate }) => {
    const repository = prepareRepository();
    const before = readModel(repository);
    const beforeById = new Map(before.manifest.nodes.map((node) => [node.id, canonicalNodeIgnoringCommit(node)]));
    const expectedStale = before.manifest.nodes
      .filter((node) => node.scope?.files?.includes(path) || node.kind === 'system')
      .map((node) => node.id)
      .sort();

    mutate(join(repository, path));
    const statusResult = run(repository, ['status', '--json']);
    expect(statusResult.status).toBe(1);
    const dirtyStatus = JSON.parse(statusResult.stdout) as {
      diff: { modified: string[] };
      stale_nodes: string[];
    };
    expect(dirtyStatus.diff.modified).toEqual([path]);
    expect(dirtyStatus.stale_nodes).toEqual(expectedStale);

    expectSuccess(repository, ['scan']);
    const after = readModel(repository);
    expect(after.snapshot.dirty).toBe(true);
    const changedIds = after.manifest.nodes
      .filter((node) => beforeById.get(node.id) !== canonicalNodeIgnoringCommit(node))
      .map((node) => node.id);
    const changedNode = nodeForPath(after.manifest.nodes, path);
    expect(changedIds).toEqual([changedNode.id]);

    const file = after.snapshot.files.find((candidate) => candidate.path === path)!;
    const fileEvidence = evidenceIn([changedNode]);
    expect(fileEvidence.length).toBeGreaterThan(0);
    expect(fileEvidence.every((evidence) =>
      evidence.path === path && evidence.commit === 'working-tree' && evidence.blob_hash === file.blob_hash)).toBe(true);
    assertManifestInvariants(after);
    expectSuccess(repository, ['status']);
  }, 30_000);

  it('preserves human/agent enrichment and fails closed before destructive partial writes', () => {
    const repository = prepareRepository();
    const output = nodeForPath(readModel(repository).manifest.nodes, 'data/output.json');
    const nodePath = join(repository, '.archmap', 'nodes', `${output.id}.yaml`);
    const document = parseYaml(readFileSync(nodePath, 'utf8')) as Node & { schema_version: number };
    const evidence = structuredClone(document.claims[0]!.evidence);
    document.claims.push(
      {
        id: 'claim_human_m3_exit_note',
        type: 'inference',
        text: 'Human-owned M3 exit note.',
        status: 'active',
        confidence: 1,
        provenance: { actor: 'human', created_at: '2026-07-14T00:00:00Z' },
        evidence,
      },
      {
        id: 'claim_agent_m3_exit_note',
        type: 'inference',
        text: 'Agent-owned M3 exit note.',
        status: 'active',
        confidence: 0.8,
        provenance: { actor: 'agent', model: 'fixture-agent', created_at: '2026-07-14T00:00:00Z' },
        evidence,
      },
    );
    writeFileSync(nodePath, stringifyYaml(document));

    expectSuccess(repository, ['scan']);
    const preserved = nodeForPath(readModel(repository).manifest.nodes, 'data/output.json');
    expect(preserved.claims.map((claim) => claim.id)).toEqual(expect.arrayContaining([
      'claim_human_m3_exit_note',
      'claim_agent_m3_exit_note',
    ]));

    const beforeFailure = trackedBytes(repository);
    unlinkSync(join(repository, 'data', 'output.json'));
    const failed = run(repository, ['scan']);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain('drop human-authored');
    expect(trackedBytes(repository)).toBe(beforeFailure);
  }, 30_000);
});

describe('M3 read-only ArchMap self-scan', () => {
  it('composes twice deterministically without creating or changing .archmap', () => {
    const storePath = join(sourceRoot, '.archmap');
    expect(existsSync(storePath)).toBe(false);
    const statusBefore = git(sourceRoot, ['status', '--porcelain=v1', '-z']).stdout;

    const firstDiscovery = discover(sourceRoot, scanConfig);
    const first = prospectiveModel(firstDiscovery, 'archmap', [], scanConfig);
    const secondDiscovery = discover(sourceRoot, scanConfig);
    const second = prospectiveModel(secondDiscovery, 'archmap', [], scanConfig);
    const firstBytes = toCanonicalJson({ snapshot: first.snapshot, nodes: first.nodes });
    const secondBytes = toCanonicalJson({ snapshot: second.snapshot, nodes: second.nodes });

    expect(secondBytes).toBe(firstBytes);
    expect(validateManifest({
      schema_version: 1,
      capabilities: first.snapshot.capabilities,
      nodes: first.nodes,
    })).toEqual({ valid: true, errors: [] });
    expect(first.nodes.some((node) =>
      node.kind === 'module' && node.scope?.files?.[0] === 'fixtures/mixed-repo/pipeline/transform.py')).toBe(true);
    expect(first.nodes.some((node) =>
      node.kind === 'store' && node.scope?.files?.[0] === 'fixtures/mixed-repo/docs/README.md')).toBe(true);
    expect(first.nodes.some((node) =>
      node.kind === 'store' && node.title === 'fixtures/mixed-repo/data/source.yaml')).toBe(true);
    expect(first.nodes.some((node) =>
      node.kind === 'store' && node.title === 'fixtures/mixed-repo/data/output.json')).toBe(true);

    expect(existsSync(storePath)).toBe(false);
    expect(git(sourceRoot, ['status', '--porcelain=v1', '-z']).stdout).toBe(statusBefore);
  }, 30_000);
});
