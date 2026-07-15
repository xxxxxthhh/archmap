/**
 * The deterministic architecture diff core (M5, issue #29).
 *
 * `diffModels` is pure: it partitions nodes, relations, and claims into added / removed /
 * changed by each entity's own stable id, comparing content canonically so formatting never
 * registers as a change. Node identity is the stable `id`, so a renamed/moved node (new
 * `slug`/`title`/`scope`, same id) is reported as `changed`, never as remove+add. Relations and
 * claims are keyed by their globally-unique ids and carry their owning node id, so a claim or
 * relation reassigned to a different node reads as a change of its `node` field.
 *
 * `architectureDiff` is the orchestrator: it resolves both refs to commits with explicit argv,
 * fails closed on an unknown/invalid ref, defines `diff X X` as the empty result, and otherwise
 * reads each side's tracked model from the object store. The core never calls `process.exit`;
 * it returns a report or throws a structured `StoreError` the CLI maps to an exit code.
 */

import { toCanonicalYaml } from '../model/canonical.js';
import type { Claim, Node, Relation } from '../model/types.js';
import { resolveCommit } from '../scan/git.js';
import { StoreError, StoreFormatError } from '../store-errors.js';
import { readNodesAt } from './read.js';
import type {
  ArchDiffReport,
  ClaimDiffSection,
  ClaimSummary,
  DiffSection,
  NodeSummary,
  RelationSummary,
} from './types.js';

/** An `archmap diff` ref could not be resolved to a commit. */
export class DiffRefError extends StoreError {}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

// --- summaries ---------------------------------------------------------------------------

function nodeSummary(node: Node): NodeSummary {
  const summary: NodeSummary = { id: node.id, slug: node.slug, kind: node.kind, title: node.title };
  if (node.scope !== undefined) summary.scope = node.scope;
  return summary;
}

const relationSummary = (nodeId: string, rel: Relation): RelationSummary => ({
  id: rel.id,
  node: nodeId,
  type: rel.type,
  target: rel.target,
  certainty: rel.certainty,
});

const claimSummary = (nodeId: string, claim: Claim): ClaimSummary => ({
  id: claim.id,
  node: nodeId,
  type: claim.type,
  status: claim.status,
  text: claim.text,
});

// --- flattening (with fail-closed id-uniqueness) -----------------------------------------

interface OwnedRelation {
  node: string;
  relation: Relation;
}
interface OwnedClaim {
  node: string;
  claim: Claim;
}

/** Flatten every relation across nodes, keyed by relation id; a duplicate id fails closed. */
function flattenRelations(nodes: Node[], commit: string): Map<string, OwnedRelation> {
  const out = new Map<string, OwnedRelation>();
  for (const node of nodes) {
    for (const relation of node.relations) {
      if (out.has(relation.id)) {
        throw new StoreFormatError(
          `duplicate relation id "${relation.id}" in tracked state at ${commit.slice(0, 12)}`,
        );
      }
      out.set(relation.id, { node: node.id, relation });
    }
  }
  return out;
}

/** Flatten every claim across nodes, keyed by claim id; a duplicate id fails closed. */
function flattenClaims(nodes: Node[], commit: string): Map<string, OwnedClaim> {
  const out = new Map<string, OwnedClaim>();
  for (const node of nodes) {
    for (const claim of node.claims) {
      if (out.has(claim.id)) {
        throw new StoreFormatError(
          `duplicate claim id "${claim.id}" in tracked state at ${commit.slice(0, 12)}`,
        );
      }
      out.set(claim.id, { node: node.id, claim });
    }
  }
  return out;
}

// --- section builders --------------------------------------------------------------------

/**
 * Partition entities into added / removed / changed. `content` yields the canonical comparison
 * string (identity fields it omits are still reported via `summary`); `summary` renders the
 * reported shape. Every list is sorted by id for byte-stable output.
 */
function partition<K, V, S extends { id: string }>(
  base: Map<K, V>,
  head: Map<K, V>,
  content: (v: V) => string,
  summary: (v: V) => S,
): DiffSection<S> {
  const added: S[] = [];
  const changed: { before: S; after: S }[] = [];
  for (const [key, headVal] of head) {
    const baseVal = base.get(key);
    if (baseVal === undefined) added.push(summary(headVal));
    else if (content(baseVal) !== content(headVal)) {
      changed.push({ before: summary(baseVal), after: summary(headVal) });
    }
  }
  const removed: S[] = [];
  for (const [key, baseVal] of base) {
    if (!head.has(key)) removed.push(summary(baseVal));
  }
  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    changed: changed.sort((a, b) => byId(a.after, b.after)),
  };
}

/** Node structural identity for change detection — display fields only, not claims/relations
 * (those are diffed as their own streams so a node is never double-reported). */
const nodeContent = (node: Node): string =>
  toCanonicalYaml({ slug: node.slug, kind: node.kind, title: node.title, scope: node.scope ?? null });

const relationContent = (owned: OwnedRelation): string =>
  toCanonicalYaml({ node: owned.node, relation: owned.relation });

const claimContent = (owned: OwnedClaim): string =>
  toCanonicalYaml({ node: owned.node, claim: owned.claim });

function nodeSection(base: Node[], head: Node[]): DiffSection<NodeSummary> {
  const b = new Map(base.map((n) => [n.id, n]));
  const h = new Map(head.map((n) => [n.id, n]));
  return partition(b, h, nodeContent, nodeSummary);
}

function relationSection(base: Node[], head: Node[], baseSha: string, headSha: string): DiffSection<RelationSummary> {
  const b = flattenRelations(base, baseSha);
  const h = flattenRelations(head, headSha);
  return partition(b, h, relationContent, (owned) => relationSummary(owned.node, owned.relation));
}

/**
 * Claims get the standard partition, then `changed` is split: a claim whose lifecycle moved
 * from non-`stale` to `stale` is surfaced in the dedicated `stale` bucket instead of `changed`,
 * so the buckets stay mutually exclusive and the headline "this claim went stale" is not buried.
 */
function claimSection(base: Node[], head: Node[], baseSha: string, headSha: string): ClaimDiffSection {
  const b = flattenClaims(base, baseSha);
  const h = flattenClaims(head, headSha);
  const section = partition(b, h, claimContent, (owned) => claimSummary(owned.node, owned.claim));

  const changed: ClaimDiffSection['changed'] = [];
  const stale: ClaimSummary[] = [];
  for (const entry of section.changed) {
    const before = b.get(entry.after.id)!;
    const after = h.get(entry.after.id)!;
    if (before.claim.status !== 'stale' && after.claim.status === 'stale') stale.push(entry.after);
    else changed.push(entry);
  }
  return { added: section.added, removed: section.removed, changed, stale: stale.sort(byId) };
}

// --- public surface ----------------------------------------------------------------------

/** Pure diff of two already-read models. Exposed for focused testing. */
export function diffModels(base: Node[], head: Node[], baseSha: string, headSha: string): ArchDiffReport {
  return {
    schema_version: 1,
    command: 'diff',
    base: baseSha,
    head: headSha,
    nodes: nodeSection(base, head),
    relations: relationSection(base, head, baseSha, headSha),
    claims: claimSection(base, head, baseSha, headSha),
  };
}

function emptyReport(baseSha: string, headSha: string): ArchDiffReport {
  return {
    schema_version: 1,
    command: 'diff',
    base: baseSha,
    head: headSha,
    nodes: { added: [], removed: [], changed: [] },
    relations: { added: [], removed: [], changed: [] },
    claims: { added: [], removed: [], changed: [], stale: [] },
  };
}

/**
 * Resolve `baseRef`/`headRef` and diff the tracked architecture between them. `root` is the
 * archmap project directory. Fails closed with `DiffRefError` on an unknown/invalid ref, and
 * defines `diff X X` (both refs resolving to the same commit) as the empty result — evaluated
 * before any model read, so an identity diff is always clean.
 */
export function architectureDiff(root: string, baseRef: string, headRef: string): ArchDiffReport {
  const baseSha = resolveCommit(root, baseRef);
  if (baseSha === null) throw new DiffRefError(`unknown or invalid base ref "${baseRef}"`);
  const headSha = resolveCommit(root, headRef);
  if (headSha === null) throw new DiffRefError(`unknown or invalid head ref "${headRef}"`);

  if (baseSha === headSha) return emptyReport(baseSha, headSha);

  return diffModels(readNodesAt(root, baseSha), readNodesAt(root, headSha), baseSha, headSha);
}
