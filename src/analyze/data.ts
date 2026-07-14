/** Bounded, content-safe YAML/JSON asset projection. */

import { parse as parseYaml } from 'yaml';
import { DATA_ADAPTER_VERSION, DATA_CAPABILITY } from '../capabilities.js';
import type { Capability, Claim, Evidence, Node, Provenance } from '../model/types.js';
import { classify } from '../scan/classify.js';
import { buildExclusionRules, excludeByName } from '../scan/exclude.js';
import { hashContent } from '../scan/hash.js';
import { nodeId, slugFor } from '../scan/nodes.js';
import type { Discovery, ProjectConfig } from '../scan/types.js';
import { ScanInputError } from '../store-errors.js';
import { isYamlJson } from './languages.js';

const ANALYZER = 'data';
const MAX_TOP_LEVEL_KEYS = 20;
const PROVENANCE: Provenance = { actor: 'analyzer', created_at: '1970-01-01T00:00:00Z' };

export { DATA_CAPABILITY };

export interface DataModelResult {
  capability: Capability;
  nodes: Node[];
}

const shortHash = (key: string): string =>
  hashContent(Buffer.from(key)).slice('sha256:'.length, 'sha256:'.length + 16);

function evidence(discovery: Discovery, path: string, extract: string): Evidence {
  const file = discovery.files.find((candidate) => candidate.path === path);
  if (!file) throw new ScanInputError(`Data evidence path is absent from discovery: ${path}`);
  return {
    repository: 'local',
    commit: discovery.dirty ? 'working-tree' : (discovery.base_commit ?? 'working-tree'),
    path,
    analyzer: ANALYZER,
    analyzer_version: DATA_ADAPTER_VERSION,
    blob_hash: file.blob_hash,
    extract_hash: hashContent(Buffer.from(extract)),
  };
}

function topLevelKeys(path: string, content: Buffer): string[] | null {
  let parsed: unknown;
  try {
    parsed = path.toLowerCase().endsWith('.json')
      ? JSON.parse(content.toString('utf8')) as unknown
      : parseYaml(content.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  return Object.keys(parsed).sort().slice(0, MAX_TOP_LEVEL_KEYS);
}

function structureClaim(discovery: Discovery, path: string, keys: string[]): Claim | null {
  if (keys.length === 0) return null;
  const keyList = keys.join(', ');
  return {
    id: `claim_${shortHash(`${path}|data-top-level-keys|${keyList}`)}`,
    type: 'fact',
    text: `Top-level keys (sorted, max ${MAX_TOP_LEVEL_KEYS}): ${keyList}.`,
    status: 'active',
    confidence: 1,
    provenance: PROVENANCE,
    evidence: [evidence(discovery, path, `top-level keys ${keyList}`)],
  };
}

/**
 * Build exactly one store node per retained YAML/JSON config/data file. Classification is
 * re-run so dependency/build manifests keep their higher precedence even if a caller hands
 * the analyzer an inconsistent synthetic discovery. Secret and size rules are also checked
 * again before parsing; repository content is never executed and values are never emitted.
 */
export function analyzeDataAssets(
  discovery: Discovery,
  scan: ProjectConfig['scan'],
): DataModelResult {
  const rules = buildExclusionRules(scan);
  const nodes: Node[] = [];

  for (const file of [...discovery.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const { path } = file;
    if (!isYamlJson(path) || file.category !== 'config' || classify(path) !== 'config') continue;
    if (excludeByName(path, rules) !== null || file.size > rules.maxFileBytes) continue;
    const content = discovery.contents.get(path);
    if (!content || content.length > rules.maxFileBytes) continue;
    if (content.length !== file.size || hashContent(content) !== file.blob_hash) {
      throw new ScanInputError(`Data content identity differs from discovery for ${path}`);
    }

    const keys = topLevelKeys(path, content);
    const claim = keys === null ? null : structureClaim(discovery, path, keys);
    nodes.push({
      id: nodeId(`data:${path}`),
      slug: slugFor(path),
      kind: 'store',
      title: path,
      scope: { files: [path] },
      claims: claim ? [claim] : [],
      relations: [],
    });
  }

  return { capability: DATA_CAPABILITY, nodes };
}
