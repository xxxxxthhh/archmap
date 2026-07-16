import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCapabilitiesCommand } from '../src/cli/capabilities-command.js';
import { runCheckCommand } from '../src/cli/check-command.js';
import { runInit } from '../src/cli/init-command.js';
import { runScanCommand } from '../src/cli/scan-command.js';
import type { Capability, Node, RelationType } from '../src/model/types.js';
import { readNodes, readSnapshot } from '../src/store.js';
import type { Snapshot } from '../src/scan/types.js';
import { validateManifest } from '../src/validate/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixtures', 'm6-pilots');
const temporaryRoots: string[] = [];
const fixedGitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Archmap M6 fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Archmap M6 fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

type PilotName = 'web-content' | 'python-data' | 'markdown-first' | 'media-pipeline';

type ExpectedRelation = {
  source: string;
  target: string;
  type: RelationType;
};

const pilots: Record<PilotName, { requiredCapabilities: string[]; expectedRelations: ExpectedRelation[] }> = {
  'web-content': {
    requiredCapabilities: ['universal', 'typescript', 'markdown', 'data'],
    expectedRelations: [
      { source: 'src/ui/page.ts', target: 'src/content.ts', type: 'imports' },
      { source: 'src/ui/page.ts', target: 'src/db/connection.ts', type: 'imports' },
      { source: 'content/intro.md', target: 'content/guide.md', type: 'depends-on' },
    ],
  },
  'python-data': {
    requiredCapabilities: ['universal', 'python', 'markdown', 'data'],
    expectedRelations: [
      { source: 'pipeline/report.py', target: 'pipeline/source.py', type: 'imports' },
      { source: 'reports/README.md', target: 'data/source.yaml', type: 'depends-on' },
    ],
  },
  'markdown-first': {
    requiredCapabilities: ['universal', 'markdown'],
    expectedRelations: [
      { source: 'README.md', target: 'docs/guide.md', type: 'depends-on' },
      { source: 'docs/guide.md', target: 'decisions/ADR-0001.md', type: 'depends-on' },
    ],
  },
  'media-pipeline': {
    requiredCapabilities: ['universal', 'typescript', 'markdown', 'data'],
    expectedRelations: [
      { source: 'scripts/render.ts', target: 'scripts/manifest.ts', type: 'imports' },
      { source: 'metadata/edit-notes.md', target: 'metadata/clip.yaml', type: 'depends-on' },
    ],
  },
};

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: fixedGitEnvironment });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
}

function copyPilot(name: PilotName): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'archmap-m6-pilot-'));
  temporaryRoots.push(temporaryRoot);
  const root = join(temporaryRoot, name);
  cpSync(join(fixtureRoot, name), root, { recursive: true });
  if (name === 'media-pipeline') {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'clip.mp4'), Buffer.from([0, 1, 2, 3, 4]));
  }
  git(root, ['init', '--quiet']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', `${name} fixture`]);
  expect(runInit([], { cwd: root }).exitCode).toBe(0);
  expect(runScanCommand([], { cwd: root }).exitCode).toBe(0);
  return root;
}

function archmapBytes(root: string): Array<[string, string]> {
  const files: string[] = [];
  const base = join(root, '.archmap');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(base);
  return files.sort().map((path) => [relative(root, path), readFileSync(path).toString('base64')]);
}

function model(root: string): { snapshot: Snapshot; nodes: Node[] } {
  const snapshot = readSnapshot(root);
  if (!snapshot) throw new Error('missing scanned snapshot');
  return { snapshot, nodes: readNodes(root) };
}

function capabilityStatus(capabilities: readonly Capability[]): Map<string, Capability['status']> {
  return new Map(capabilities.map((capability) => [capability.id, capability.status]));
}

function assertDeterministicEvidence(snapshot: Snapshot, nodes: Node[]): void {
  const statuses = capabilityStatus(snapshot.capabilities);
  const assertEvidence = (evidence: { analyzer: string }[]): void => {
    expect(evidence.length).toBeGreaterThan(0);
    for (const entry of evidence) expect(statuses.get(entry.analyzer)).toBe('supported');
  };

  for (const node of nodes) {
    for (const claim of node.claims) {
      if (claim.type === 'fact') {
        expect(claim.provenance.actor).toBe('analyzer');
        assertEvidence(claim.evidence);
      }
    }
    for (const relation of node.relations) {
      if (relation.certainty === 'known') {
        expect(relation.provenance?.actor).toBe('analyzer');
        assertEvidence(relation.evidence ?? []);
      }
    }
  }
}

function signature(source: string, type: RelationType, target: string): string {
  return `${source}\u0000${type}\u0000${target}`;
}

function actualKnownRelations(nodes: Node[], expected: ExpectedRelation[]): Set<string> {
  const selectedPaths = new Set(expected.flatMap((relation) => [relation.source, relation.target]));
  const pathsForNode = new Map(nodes.map((node) => [node.id, node.scope?.files ?? []]));
  const actual = new Set<string>();

  for (const node of nodes) {
    const sourcePaths = (node.scope?.files ?? []).filter((path) => selectedPaths.has(path));
    if (sourcePaths.length === 0) continue;
    for (const relation of node.relations) {
      if (relation.certainty !== 'known') continue;
      const targetPaths = (pathsForNode.get(relation.target) ?? []).filter((path) => selectedPaths.has(path));
      for (const source of sourcePaths) {
        for (const target of targetPaths) actual.add(signature(source, relation.type, target));
      }
    }
  }
  return actual;
}

function assertExpectedRelationPrecision(nodes: Node[], expected: ExpectedRelation[]): void {
  const expectedSet = new Set(expected.map((relation) => signature(relation.source, relation.type, relation.target)));
  const actual = actualKnownRelations(nodes, expected);
  const truePositives = [...actual].filter((relation) => expectedSet.has(relation));
  const precision = actual.size === 0 ? 0 : truePositives.length / actual.size;

  expect(actual).toEqual(expectedSet);
  expect(precision).toBeGreaterThanOrEqual(0.95);
}

function writeRule(root: string, severity: 'warning' | 'error'): void {
  const directory = join(root, '.archmap', 'rules');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'ui-must-not-access-db.yaml'),
    `schema_version: 1\nid: ui-must-not-access-db\nseverity: ${severity}\nfrom:\n  path: src/ui/**\ndisallow:\n  edge_type: imports\n  target:\n    path: src/db/**\n`,
  );
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('M6 CI and pilot exit evidence', () => {
  it('runs four self-contained pilots with truthful capabilities, deterministic models, and stable relation matrices', () => {
    for (const [name, contract] of Object.entries(pilots) as Array<[PilotName, (typeof pilots)[PilotName]]>) {
      const root = copyPilot(name);
      const report = JSON.parse(runCapabilitiesCommand(['--json'], { cwd: root }).stdout) as {
        environment: { git: boolean };
        adapters: Capability[];
      };
      const { snapshot, nodes } = model(root);
      const statuses = capabilityStatus(report.adapters);

      expect(report.environment.git).toBe(true);
      for (const capability of contract.requiredCapabilities) expect(statuses.get(capability)).toBe('supported');
      expect(validateManifest({ schema_version: 1, capabilities: snapshot.capabilities, nodes })).toEqual({
        valid: true,
        errors: [],
      });
      assertDeterministicEvidence(snapshot, nodes);
      assertExpectedRelationPrecision(nodes, contract.expectedRelations);

      const before = archmapBytes(root);
      expect(runScanCommand([], { cwd: root }).exitCode).toBe(0);
      expect(archmapBytes(root)).toEqual(before);

      const manualClaimsOrRelations = nodes.flatMap((node) => [
        ...node.claims.filter((claim) => claim.provenance.actor !== 'analyzer'),
        ...node.relations.filter((relation) => relation.provenance?.actor !== 'analyzer'),
      ]);
      expect(manualClaimsOrRelations).toEqual([]);

      if (name === 'media-pipeline') {
        expect(report.adapters.some((capability) => capability.id === 'media')).toBe(false);
        expect(snapshot.files.some((file) => file.path === 'assets/clip.mp4')).toBe(false);
        expect(snapshot.excluded_counts.binary).toBe(1);
        expect(nodes.some((node) => node.scope?.files?.includes('assets/clip.mp4'))).toBe(false);
      }
    }
  }, 60_000);

  it('preserves the documented warning, strict, blocking, and malformed-input CI outcomes without writing', () => {
    const root = copyPilot('web-content');
    writeRule(root, 'warning');
    let before = archmapBytes(root);

    const advisory = runCheckCommand(['--json'], { cwd: root });
    const strict = runCheckCommand(['--strict', '--json'], { cwd: root });
    expect(advisory.exitCode).toBe(0);
    expect(JSON.parse(advisory.stdout)).toMatchObject({ status: 'warning', summary: { blocking: 0 } });
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(strict.stdout)).toMatchObject({ status: 'fail', summary: { blocking: 1 } });
    expect(archmapBytes(root)).toEqual(before);

    writeRule(root, 'error');
    before = archmapBytes(root);
    const blocking = runCheckCommand(['--json'], { cwd: root });
    expect(blocking.exitCode).toBe(1);
    expect(JSON.parse(blocking.stdout)).toMatchObject({ status: 'fail', summary: { errors: 1, blocking: 1 } });
    expect(archmapBytes(root)).toEqual(before);

    writeFileSync(join(root, '.archmap', 'rules', 'broken.yaml'), 'schema_version: 1\nid: broken\nseverity: fatal\n');
    before = archmapBytes(root);
    const malformed = runCheckCommand(['--json'], { cwd: root });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toBe('');
    expect(JSON.parse(malformed.stderr).error).toContain('invalid rule');
    expect(archmapBytes(root)).toEqual(before);
  });

  it('reports a stale pilot model as a blocking CI result without writing a cache or report', () => {
    const root = copyPilot('web-content');
    const before = archmapBytes(root);
    writeFileSync(join(root, 'src', 'content.ts'), "export const introPath = 'content/changed.md';\n");

    const out = runCheckCommand(['--json'], { cwd: root });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({
      status: 'fail',
      violations: [expect.objectContaining({ kind: 'stale-model', blocking: true })],
    });
    expect(archmapBytes(root)).toEqual(before);
  });
});
