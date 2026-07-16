/**
 * Shapes for the deterministic commit-to-commit architecture diff report (M5, issue #29).
 *
 * The report partitions three independent entity streams — nodes, relations, and claims — each
 * into added / removed / changed, keyed by the entity's own stable id. Because a node's `id` is
 * stable while its `slug`/`title`/`scope` are renameable, a persisted id whose display fields
 * change lands in `changed`, never as a remove+add pair. Claims additionally carry a `stale`
 * bucket for the lifecycle transition into `stale` (see `diff.ts`).
 *
 * Every list is sorted by id so equal inputs always serialize byte-identically.
 */

import type {
  ClaimStatus,
  ClaimType,
  NodeKind,
  RelationCertainty,
  RelationType,
  Scope,
} from '../model/types.js';

/** Identity + key display fields of a node version. */
export interface NodeSummary {
  id: string;
  slug: string;
  kind: NodeKind;
  title: string;
  scope?: Scope;
}

/** Identity + key display fields of a relation version, with its owning node id. */
export interface RelationSummary {
  id: string;
  /** Stable id of the node that owns this relation. */
  node: string;
  type: RelationType;
  target: string;
  certainty: RelationCertainty;
}

/** Identity + key display fields of a claim version, with its owning node id. */
export interface ClaimSummary {
  id: string;
  /** Stable id of the node that owns this claim. */
  node: string;
  type: ClaimType;
  status: ClaimStatus;
  text: string;
}

/** A single entity whose content changed between the two commits. */
export interface Change<T> {
  before: T;
  after: T;
}

/** Added / removed / changed partition for one entity stream. */
export interface DiffSection<T> {
  added: T[];
  removed: T[];
  changed: Change<T>[];
}

/** Claim stream: the standard partition plus claims that transitioned into `stale`. */
export interface ClaimDiffSection extends DiffSection<ClaimSummary> {
  stale: ClaimSummary[];
}

/** The full architecture diff, schema-versioned for stable JSON output. */
export interface ArchDiffReport {
  schema_version: 1;
  command: 'diff';
  /** Resolved base commit SHA. */
  base: string;
  /** Resolved head commit SHA. */
  head: string;
  nodes: DiffSection<NodeSummary>;
  relations: DiffSection<RelationSummary>;
  claims: ClaimDiffSection;
}
