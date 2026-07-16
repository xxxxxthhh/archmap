import type { Node } from '../model/types.js';
import { compareCodeUnits } from '../model/canonical.js';
import type { StatusResult } from '../scan/status.js';
import { StoreFormatError } from '../store-errors.js';
import { matchesPathGlob } from './rules.js';
import type {
  CheckReport,
  CheckViolation,
  DisallowRule,
  RuleViolation,
  StaleModelViolation,
} from './types.js';

function matchingPaths(node: Node, pattern: string): string[] {
  return (node.scope?.files ?? []).filter((path) => matchesPathGlob(pattern, path)).sort(compareCodeUnits);
}

function changedFileCount(status: StatusResult): number {
  const diff = status.diff;
  if (!diff) return 0;
  return diff.added.length + diff.modified.length + diff.deleted.length + diff.renamed.length;
}

function violationKey(violation: CheckViolation): string {
  if (violation.kind === 'stale-model') return '0';
  return [
    '1',
    violation.rule_id,
    violation.source_node_id,
    violation.relation_id,
    violation.target_node_id,
    violation.source_path,
    violation.target_path,
  ].join('\u0000');
}

function staleViolation(status: StatusResult): StaleModelViolation | null {
  if (status.clean) return null;
  return {
    kind: 'stale-model',
    severity: 'error',
    blocking: true,
    stale_node_count: status.stale_nodes.length,
    changed_file_count: changedFileCount(status),
    drift: [...status.drift].sort(compareCodeUnits),
  };
}

/**
 * Evaluate the v1 rules only from the validated tracked baseline. Partial and unknown
 * relationships are deliberately advisory: they identify a possible conflict without
 * promoting incomplete analyzer output to a deterministic blocking fact.
 */
export function evaluateCheck(
  nodes: Node[],
  status: StatusResult,
  rules: DisallowRule[],
  strict: boolean,
): CheckReport {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const violations: CheckViolation[] = [];
  const stale = staleViolation(status);
  if (stale) violations.push(stale);

  for (const rule of rules) {
    for (const source of nodes) {
      const sourcePaths = matchingPaths(source, rule.from.path);
      if (sourcePaths.length === 0) continue;

      for (const relation of source.relations) {
        if (relation.type !== rule.disallow.edge_type) continue;
        const target = nodeById.get(relation.target);
        if (!target) {
          throw new StoreFormatError(`validated model lost relation target ${JSON.stringify(relation.target)}`);
        }
        const targetPaths = matchingPaths(target, rule.disallow.target.path);
        if (targetPaths.length === 0) continue;

        const severity = relation.certainty === 'known' ? rule.severity : 'warning';
        const violation: RuleViolation = {
          kind: 'rule',
          rule_id: rule.id,
          severity,
          blocking: severity === 'error' || strict,
          source_node_id: source.id,
          target_node_id: target.id,
          source_path: sourcePaths[0]!,
          target_path: targetPaths[0]!,
          relation_id: relation.id,
          relation_type: relation.type,
          certainty: relation.certainty,
        };
        violations.push(violation);
      }
    }
  }

  violations.sort((a, b) => compareCodeUnits(violationKey(a), violationKey(b)));
  const summary = violations.reduce(
    (result, violation) => {
      if (violation.severity === 'error') result.errors += 1;
      else result.warnings += 1;
      if (violation.blocking) result.blocking += 1;
      return result;
    },
    { blocking: 0, errors: 0, warnings: 0 },
  );

  return {
    schema_version: 1,
    command: 'check',
    strict,
    status: summary.blocking > 0 ? 'fail' : summary.warnings > 0 ? 'warning' : 'pass',
    summary,
    violations,
  };
}
