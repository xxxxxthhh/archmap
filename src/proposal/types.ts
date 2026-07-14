import type { Claim, ClaimStatus, Relation } from '../model/types.js';

export const PROPOSAL_SCHEMA_VERSION = 1;

export type ProposalVerdict = 'valid' | 'invalid' | 'forbidden' | 'requires-approval';
export type ProposalMutation = 'add' | 'replace' | 'remove';
export type ProposalTargetClass =
  | 'node'
  | 'claim'
  | 'relation'
  | 'evidence'
  | 'capability'
  | 'snapshot'
  | 'project';

export interface ProposalTarget {
  class: ProposalTargetClass;
  node_id?: string;
  id?: string;
  field?: string;
}

export interface ProposalOperation {
  op: ProposalMutation;
  target: ProposalTarget;
  value?: unknown;
}

export interface Proposal {
  proposal_schema_version: typeof PROPOSAL_SCHEMA_VERSION;
  base_commit: string | null;
  model_hash: string;
  operations: ProposalOperation[];
}

export interface ProposalError {
  path: string;
  code:
    | 'schema'
    | 'stale-base'
    | 'not-found'
    | 'duplicate-id'
    | 'colliding-operation'
    | 'forbidden-target'
    | 'forbidden-content'
    | 'invalid-evidence-path'
    | 'evidence-mismatch'
    | 'invalid-projection'
    | 'proposal-load';
  message: string;
}

export interface ProposalConflict {
  id: string;
  operation_index: number;
  kind: 'human-claim' | 'human-relation' | 'legacy-relation';
  node_id: string;
  entity_id: string;
}

export interface ProposalNodeDiff {
  path: string;
  before: string;
  after: string;
}

export interface ProposalEvaluation {
  verdict: ProposalVerdict;
  errors: ProposalError[];
  conflicts: ProposalConflict[];
  diff?: ProposalNodeDiff[];
}

export type AddClaimOperation = ProposalOperation & {
  op: 'add';
  target: ProposalTarget & { class: 'claim'; node_id: string };
  value: Claim;
};

export type ReplaceClaimStatusOperation = ProposalOperation & {
  op: 'replace';
  target: ProposalTarget & { class: 'claim'; node_id: string; id: string; field: 'status' };
  value: ClaimStatus;
};

export type AddRelationOperation = ProposalOperation & {
  op: 'add';
  target: ProposalTarget & { class: 'relation'; node_id: string };
  value: Relation;
};

export type RemoveRelationOperation = ProposalOperation & {
  op: 'remove';
  target: ProposalTarget & { class: 'relation'; node_id: string; id: string };
};

export type AuthorizedOperation =
  | AddClaimOperation
  | ReplaceClaimStatusOperation
  | AddRelationOperation
  | RemoveRelationOperation;
