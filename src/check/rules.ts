import { parse as parseYaml } from 'yaml';
import { compareCodeUnits } from '../model/canonical.js';
import type { RelationType } from '../model/types.js';
import { readRuleDocuments } from '../store.js';
import { StoreFormatError } from '../store-errors.js';
import type { DisallowRule, RuleSeverity } from './types.js';

const RELATION_TYPES = new Set<RelationType>([
  'calls',
  'reads',
  'writes',
  'imports',
  'publishes',
  'consumes',
  'depends-on',
]);
const RULE_ID = /^[a-z][a-z0-9-]*$/;
const MAX_GLOB_LENGTH = 512;

function invalidRule(source: string, message: string): never {
  throw new StoreFormatError(`invalid rule ${source}: ${message}`);
}

function object(value: unknown, source: string, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidRule(source, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, source: string, label: string, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidRule(source, `${label} has unknown property ${JSON.stringify(key)}`);
  }
}

function string(value: Record<string, unknown>, key: string, source: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    invalidRule(source, `${label}.${key} must be a non-empty string`);
  }
  return candidate;
}

function pathGlob(value: string, source: string, label: string): string {
  if (value.length > MAX_GLOB_LENGTH) invalidRule(source, `${label} is too long`);
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    invalidRule(source, `${label} must be a repository-relative path glob`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    invalidRule(source, `${label} must not contain empty, . or .. path segments`);
  }
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    invalidRule(source, `${label} may use ** only as a complete path segment`);
  }
  return value;
}

function parseRule(source: string, text: string): DisallowRule {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    invalidRule(source, 'not valid YAML');
  }

  const root = object(parsed, source, 'rule');
  exactKeys(root, source, 'rule', ['schema_version', 'id', 'severity', 'from', 'disallow']);
  if (root.schema_version !== 1) {
    invalidRule(source, `unsupported schema_version ${String(root.schema_version)}; supported: 1`);
  }

  const id = string(root, 'id', source, 'rule');
  if (!RULE_ID.test(id)) invalidRule(source, 'rule.id must use lowercase letters, digits, and hyphens');

  const severity = string(root, 'severity', source, 'rule');
  if (severity !== 'warning' && severity !== 'error') {
    invalidRule(source, 'rule.severity must be warning or error');
  }

  const from = object(root.from, source, 'rule.from');
  exactKeys(from, source, 'rule.from', ['path']);
  const fromPath = pathGlob(string(from, 'path', source, 'rule.from'), source, 'rule.from.path');

  const disallow = object(root.disallow, source, 'rule.disallow');
  exactKeys(disallow, source, 'rule.disallow', ['edge_type', 'target']);
  const edgeType = string(disallow, 'edge_type', source, 'rule.disallow');
  if (!RELATION_TYPES.has(edgeType as RelationType)) {
    invalidRule(source, `rule.disallow.edge_type is unsupported: ${JSON.stringify(edgeType)}`);
  }
  const target = object(disallow.target, source, 'rule.disallow.target');
  exactKeys(target, source, 'rule.disallow.target', ['path']);
  const targetPath = pathGlob(
    string(target, 'path', source, 'rule.disallow.target'),
    source,
    'rule.disallow.target.path',
  );

  return {
    schema_version: 1,
    id,
    severity: severity as RuleSeverity,
    from: { path: fromPath },
    disallow: { edge_type: edgeType as RelationType, target: { path: targetPath } },
  };
}

/** Read and strictly validate the current local rule set. */
export function loadRules(root: string): DisallowRule[] {
  const rules = readRuleDocuments(root).map((document) => parseRule(document.name, document.text));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) invalidRule(rule.id, 'duplicate rule id');
    seen.add(rule.id);
  }
  return rules.sort((a, b) => compareCodeUnits(a.id, b.id));
}

function segmentMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let wildcard = -1;
  let matchedAfterWildcard = 0;

  while (valueIndex < value.length) {
    const token = pattern.charAt(patternIndex);
    if (token === '*') {
      wildcard = patternIndex;
      patternIndex += 1;
      matchedAfterWildcard = valueIndex;
    } else if (token === value.charAt(valueIndex)) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (wildcard !== -1) {
      patternIndex = wildcard + 1;
      matchedAfterWildcard += 1;
      valueIndex = matchedAfterWildcard;
    } else {
      return false;
    }
  }

  while (pattern.charAt(patternIndex) === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

/** Match a repository-relative path with `*` within a segment and `**` across segments. */
export function matchesPathGlob(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const memo = new Map<string, boolean>();

  const matches = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else {
      const segment = patternSegments[patternIndex]!;
      if (segment === '**') {
        result = matches(patternIndex + 1, pathIndex) || (
          pathIndex < pathSegments.length && matches(patternIndex, pathIndex + 1)
        );
      } else {
        result = pathIndex < pathSegments.length &&
          segmentMatches(segment, pathSegments[pathIndex]!) &&
          matches(patternIndex + 1, pathIndex + 1);
      }
    }
    memo.set(key, result);
    return result;
  };

  return matches(0, 0);
}
