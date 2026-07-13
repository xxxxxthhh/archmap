/**
 * v1 data contract for the archmap knowledge model.
 *
 * These TypeScript types mirror the tracked JSON Schema in `schema/manifest.schema.json`.
 * The JSON Schema is the authoritative structural contract; these types exist so the rest
 * of the codebase can consume validated manifests with static typing. Keep both in sync.
 */

/** Schema version this build of archmap understands. */
export const SCHEMA_VERSION = 1;

/** Node categories used in architecture views. */
export type NodeKind = 'system' | 'component' | 'module' | 'external' | 'store';

/** Relationship types between nodes. */
export type RelationType =
  | 'calls'
  | 'reads'
  | 'writes'
  | 'imports'
  | 'publishes'
  | 'consumes'
  | 'depends-on';

/**
 * Certainty a relation is asserted with. `known` relations are backed by deterministic
 * evidence; `partial`/`unknown` capture relations an adapter could not fully resolve and
 * must never be presented as deterministic facts.
 */
export type RelationCertainty = 'known' | 'partial' | 'unknown';

/**
 * A claim is either a deterministic `fact` (produced by a static analyzer) or an
 * `inference` (added by an agent or human, still evidence-backed).
 */
export type ClaimType = 'fact' | 'inference';

/** Lifecycle status of a claim. */
export type ClaimStatus = 'active' | 'stale' | 'rejected';

/** Who produced a claim. */
export type Actor = 'analyzer' | 'agent' | 'human';

/**
 * Whether an analyzer can produce a given capability deterministically. `partial` and
 * `unsupported` capabilities must never back a deterministic `fact` (PLAN 3.5, 13.3).
 */
export type CapabilityStatus = 'supported' | 'partial' | 'unsupported';

/**
 * A declared analyzer/adapter capability. `id` + `version` form the re-verification
 * identity: a fact extracted by analyzer `id` at `version` can be recomputed by running
 * the same analyzer version against the same blob (PLAN 3.2, "相同输入 + 相同分析器版本").
 */
export interface Capability {
  id: string;
  version: string;
  status: CapabilityStatus;
  /** Optional tags describing what the capability provides (e.g. `imports`, `symbols`). */
  provides?: string[];
}

/**
 * A re-verifiable pointer into repository content. Evidence stores identifiers and
 * hashes, not copied source. Line numbers are intentionally absent from long-term
 * identity (see PLAN 3.2); `symbol` and hashes carry identity instead.
 *
 * `analyzer` + `analyzer_version` name the capability that produced this pointer and must
 * reference a declared `Capability` in the same manifest.
 */
export interface Evidence {
  repository: string;
  commit: string;
  path: string;
  symbol?: string;
  analyzer: string;
  analyzer_version: string;
  blob_hash: string;
  extract_hash: string;
}

/** Origin metadata for a claim. */
export interface Provenance {
  actor: Actor;
  /** Optional model id when `actor` is `agent`. */
  model?: string;
  /** ISO 8601 timestamp. */
  created_at: string;
}

/**
 * A single assertion about a node.
 *
 * For `fact`, `confidence` represents parse completeness, not subjective probability.
 * For `inference`, `confidence` represents reasoning confidence.
 */
export interface Claim {
  id: string;
  type: ClaimType;
  text: string;
  status: ClaimStatus;
  confidence: number;
  provenance: Provenance;
  evidence: Evidence[];
}

/** A directed relationship from the owning node to `target`. */
export interface Relation {
  id: string;
  type: RelationType;
  /** Node id this relation points at. */
  target: string;
  certainty: RelationCertainty;
  /**
   * Who authored this relation. `actor: analyzer` marks a scanner-owned relation that is
   * rebuilt each scan; any other actor (or an absent provenance, as on legacy relations) is
   * human/agent enrichment that scans must preserve. This makes relation ownership an
   * explicit part of the contract rather than an id-naming convention.
   */
  provenance?: Provenance;
  evidence?: Evidence[];
}

/** Files and symbols a node covers. */
export interface Scope {
  files?: string[];
  symbols?: string[];
}

/** An architecture node with a stable internal id and a renameable display slug. */
export interface Node {
  id: string;
  slug: string;
  kind: NodeKind;
  title: string;
  scope?: Scope;
  claims: Claim[];
  relations: Relation[];
}

/** A validated bundle of nodes. */
export interface Manifest {
  schema_version: typeof SCHEMA_VERSION;
  capabilities: Capability[];
  nodes: Node[];
}
