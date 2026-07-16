import type { RelationCertainty, RelationType } from '../model/types.js';

export type RuleSeverity = 'warning' | 'error';

/** The first, deliberately narrow local architecture-rule shape. */
export interface DisallowRule {
  schema_version: 1;
  id: string;
  severity: RuleSeverity;
  from: { path: string };
  disallow: {
    edge_type: RelationType;
    target: { path: string };
  };
}

export interface RuleViolation {
  kind: 'rule';
  rule_id: string;
  severity: RuleSeverity;
  blocking: boolean;
  source_node_id: string;
  target_node_id: string;
  source_path: string;
  target_path: string;
  relation_id: string;
  relation_type: RelationType;
  certainty: RelationCertainty;
}

export interface StaleModelViolation {
  kind: 'stale-model';
  severity: 'error';
  blocking: true;
  stale_node_count: number;
  changed_file_count: number;
  drift: string[];
}

export type CheckViolation = RuleViolation | StaleModelViolation;

export interface CheckSummary {
  blocking: number;
  errors: number;
  warnings: number;
}

export interface CheckReport {
  schema_version: 1;
  command: 'check';
  strict: boolean;
  status: 'pass' | 'warning' | 'fail';
  summary: CheckSummary;
  violations: CheckViolation[];
}
