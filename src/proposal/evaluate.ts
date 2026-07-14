import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { toCanonicalJson, toCanonicalYaml } from '../model/canonical.js';
import type { Evidence, Node } from '../model/types.js';
import type { TrackedBaseline } from '../scan/baseline.js';
import { validateManifest } from '../validate/validate.js';
import { computeModelHash } from './fingerprint.js';
import { sortErrors, validateProposalStructure } from './schema.js';
import type {
  AddClaimOperation,
  AddRelationOperation,
  AuthorizedOperation,
  Proposal,
  ProposalConflict,
  ProposalError,
  ProposalEvaluation,
  ProposalNodeDiff,
  ProposalOperation,
  RemoveRelationOperation,
  ReplaceClaimStatusOperation,
} from './types.js';

export function validateProposal(input: unknown, baseline: TrackedBaseline): ProposalEvaluation {
  return evaluate(input, baseline, false);
}

export function previewProposal(input: unknown, baseline: TrackedBaseline): ProposalEvaluation {
  return evaluate(input, baseline, true);
}

function evaluate(input: unknown, baseline: TrackedBaseline, includeDiff: boolean): ProposalEvaluation {
  const structure = validateProposalStructure(input);
  if (!structure.valid) return result('invalid', structure.errors);
  const proposal = structure.proposal;

  const fingerprintErrors = checkBaselineFingerprint(proposal, baseline);
  if (fingerprintErrors.length > 0) return result('invalid', fingerprintErrors);

  const staticAuthorizationErrors = authorizeStatic(proposal);
  if (staticAuthorizationErrors.length > 0) return result('forbidden', staticAuthorizationErrors);

  const referenceErrors = checkReferencesAndCollisions(proposal, baseline);
  if (referenceErrors.length > 0) return result('invalid', referenceErrors);

  const authorizationErrors = authorizeExistingContent(proposal, baseline);
  if (authorizationErrors.length > 0) return result('forbidden', authorizationErrors);

  const operations = proposal.operations as AuthorizedOperation[];
  const conflicts = findConflicts(operations, baseline);
  if (conflicts.length > 0) return { verdict: 'requires-approval', errors: [], conflicts };

  const projected = project(operations, baseline.nodes);
  const projectionErrors = validateProjection(projected, operations, baseline);
  if (projectionErrors.length > 0) return result('invalid', projectionErrors);

  if (!includeDiff) return result('valid', []);
  return { verdict: 'valid', errors: [], conflicts: [], diff: buildDiff(baseline.nodes, projected) };
}

function result(verdict: ProposalEvaluation['verdict'], errors: ProposalError[]): ProposalEvaluation {
  return { verdict, errors: sortErrors(errors), conflicts: [] };
}

function checkBaselineFingerprint(proposal: Proposal, baseline: TrackedBaseline): ProposalError[] {
  if (proposal.base_commit !== baseline.snapshot.base_commit || proposal.model_hash !== computeModelHash(baseline)) {
    return [{
      path: proposal.base_commit !== baseline.snapshot.base_commit ? '/base_commit' : '/model_hash',
      code: 'stale-base',
      message: 'proposal baseline does not match the current tracked validated model',
    }];
  }
  return [];
}

function checkReferencesAndCollisions(proposal: Proposal, baseline: TrackedBaseline): ProposalError[] {
  const errors: ProposalError[] = [];
  const nodeById = new Map(baseline.nodes.map((node) => [node.id, node]));
  const globalIds = new Set<string>();
  for (const node of baseline.nodes) {
    globalIds.add(node.id);
    node.claims.forEach((claim) => globalIds.add(claim.id));
    node.relations.forEach((relation) => globalIds.add(relation.id));
  }
  const mutations = new Set<string>();

  proposal.operations.forEach((operation, index) => {
    const base = `/operations/${index}`;
    const nodeId = operation.target.node_id;
    const node = nodeId === undefined ? undefined : nodeById.get(nodeId);
    const mayBeAuthorized = operation.target.class === 'claim' || operation.target.class === 'relation';
    if (mayBeAuthorized && nodeId !== undefined && !node) {
      errors.push({ path: `${base}/target/node_id`, code: 'not-found', message: `node "${nodeId}" does not exist` });
      return;
    }

    let entityId: string | undefined;
    if (operation.op === 'add' && (operation.target.class === 'claim' || operation.target.class === 'relation')) {
      entityId = (operation.value as { id?: unknown } | undefined)?.id as string | undefined;
      if (entityId !== undefined && globalIds.has(entityId)) {
        errors.push({ path: `${base}/value/id`, code: 'duplicate-id', message: `id "${entityId}" already exists` });
      }
      if (operation.target.class === 'relation') {
        const target = (operation.value as { target?: unknown } | undefined)?.target;
        if (typeof target === 'string' && !nodeById.has(target)) {
          errors.push({ path: `${base}/value/target`, code: 'not-found', message: `node "${target}" does not exist` });
        }
      }
    } else if (node && operation.target.id !== undefined) {
      entityId = operation.target.id;
      const exists = operation.target.class === 'claim'
        ? node.claims.some((claim) => claim.id === entityId)
        : operation.target.class === 'relation'
          ? node.relations.some((relation) => relation.id === entityId)
          : true;
      if (!exists) {
        errors.push({ path: `${base}/target/id`, code: 'not-found', message: `${operation.target.class} "${entityId}" does not exist` });
      }
    }

    if (nodeId !== undefined && entityId !== undefined) {
      const key = `${operation.target.class}\0${nodeId}\0${entityId}`;
      if (mutations.has(key)) {
        errors.push({ path: base, code: 'colliding-operation', message: `multiple operations mutate "${entityId}"` });
      }
      mutations.add(key);
      if (operation.op === 'add') globalIds.add(entityId);
    }
  });
  return sortErrors(errors);
}

function authorizeStatic(proposal: Proposal): ProposalError[] {
  const errors: ProposalError[] = [];
  proposal.operations.forEach((operation, index) => {
    const base = `/operations/${index}`;
    if (isAddClaim(operation)) {
      if (operation.value.type !== 'inference' || operation.value.provenance.actor !== 'agent') {
        errors.push({ path: `${base}/value`, code: 'forbidden-content', message: 'only agent-authored inference claims may be added' });
      }
      return;
    }
    if (isReplaceClaimStatus(operation)) {
      return;
    }
    if (isAddRelation(operation)) {
      if (operation.value.provenance?.actor !== 'agent' || operation.value.certainty === 'known') {
        errors.push({ path: `${base}/value`, code: 'forbidden-content', message: 'only agent-owned partial or unknown relations may be added' });
      }
      return;
    }
    if (isRemoveRelation(operation)) {
      return;
    }
    errors.push({
      path: `${base}/target`,
      code: 'forbidden-target',
      message: `operation ${operation.op} is not authorized for target class "${operation.target.class}"`,
    });
  });
  return sortErrors(errors);
}

function authorizeExistingContent(proposal: Proposal, baseline: TrackedBaseline): ProposalError[] {
  const errors: ProposalError[] = [];
  const nodeById = new Map(baseline.nodes.map((node) => [node.id, node]));
  proposal.operations.forEach((operation, index) => {
    const base = `/operations/${index}`;
    if (isReplaceClaimStatus(operation)) {
      const claim = nodeById.get(operation.target.node_id)!.claims.find((entry) => entry.id === operation.target.id)!;
      if (claim.provenance.actor === 'analyzer') {
        errors.push({ path: `${base}/target`, code: 'forbidden-content', message: 'analyzer-owned claims are immutable' });
      }
    } else if (isRemoveRelation(operation)) {
      const relation = nodeById.get(operation.target.node_id)!.relations.find((entry) => entry.id === operation.target.id)!;
      if (relation.certainty === 'known') {
        errors.push({ path: `${base}/target`, code: 'forbidden-content', message: 'known relations are immutable' });
      } else if (relation.provenance?.actor === 'analyzer') {
        errors.push({ path: `${base}/target`, code: 'forbidden-content', message: 'analyzer-owned relations are immutable' });
      }
    }
  });
  return sortErrors(errors);
}

function isAddClaim(operation: ProposalOperation): operation is AddClaimOperation {
  return operation.op === 'add' && operation.target.class === 'claim';
}

function isReplaceClaimStatus(operation: ProposalOperation): operation is ReplaceClaimStatusOperation {
  return operation.op === 'replace' && operation.target.class === 'claim' && operation.target.field === 'status';
}

function isAddRelation(operation: ProposalOperation): operation is AddRelationOperation {
  return operation.op === 'add' && operation.target.class === 'relation';
}

function isRemoveRelation(operation: ProposalOperation): operation is RemoveRelationOperation {
  return operation.op === 'remove' && operation.target.class === 'relation';
}

function findConflicts(operations: AuthorizedOperation[], baseline: TrackedBaseline): ProposalConflict[] {
  const nodeById = new Map(baseline.nodes.map((node) => [node.id, node]));
  const conflicts: ProposalConflict[] = [];
  operations.forEach((operation, index) => {
    if (isReplaceClaimStatus(operation)) {
      const claim = nodeById.get(operation.target.node_id)!.claims.find((entry) => entry.id === operation.target.id)!;
      if (claim.provenance.actor === 'human') {
        conflicts.push(conflict(index, 'human-claim', operation.target.node_id, claim.id));
      }
    } else if (isRemoveRelation(operation)) {
      const relation = nodeById.get(operation.target.node_id)!.relations.find((entry) => entry.id === operation.target.id)!;
      if (relation.provenance?.actor === 'human') {
        conflicts.push(conflict(index, 'human-relation', operation.target.node_id, relation.id));
      } else if (relation.provenance === undefined) {
        conflicts.push(conflict(index, 'legacy-relation', operation.target.node_id, relation.id));
      }
    }
  });
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

function conflict(
  operationIndex: number,
  kind: ProposalConflict['kind'],
  nodeId: string,
  entityId: string,
): ProposalConflict {
  const hash = createHash('sha256').update(toCanonicalJson({ kind, node_id: nodeId, entity_id: entityId })).digest('hex');
  return { id: `conflict_${hash.slice(0, 24)}`, operation_index: operationIndex, kind, node_id: nodeId, entity_id: entityId };
}

function project(operations: AuthorizedOperation[], nodes: Node[]): Node[] {
  const projected = structuredClone(nodes).sort((a, b) => a.id.localeCompare(b.id));
  const nodeById = new Map(projected.map((node) => [node.id, node]));
  for (const operation of operations) {
    const node = nodeById.get(operation.target.node_id)!;
    if (isAddClaim(operation)) {
      node.claims.push(structuredClone(operation.value));
    } else if (isReplaceClaimStatus(operation)) {
      node.claims.find((claim) => claim.id === operation.target.id)!.status = operation.value;
    } else if (isAddRelation(operation)) {
      node.relations.push(structuredClone(operation.value));
    } else {
      node.relations = node.relations.filter((relation) => relation.id !== operation.target.id);
    }
  }
  return projected;
}

function validateProjection(
  nodes: Node[],
  operations: AuthorizedOperation[],
  baseline: TrackedBaseline,
): ProposalError[] {
  const errors: ProposalError[] = [];
  operations.forEach((operation, index) => {
    if (isAddClaim(operation)) {
      operation.value.evidence.forEach((evidence, evidenceIndex) => {
        checkEvidence(evidence, `/operations/${index}/value/evidence/${evidenceIndex}`, baseline, errors);
      });
    } else if (isAddRelation(operation)) {
      operation.value.evidence?.forEach((evidence, evidenceIndex) => {
        checkEvidence(evidence, `/operations/${index}/value/evidence/${evidenceIndex}`, baseline, errors);
      });
    }
  });
  if (errors.length > 0) return sortErrors(errors);

  const validation = validateManifest({ schema_version: 1, capabilities: baseline.snapshot.capabilities, nodes });
  return sortErrors(
    validation.errors.map((error) => ({
      path: error.path,
      code: 'invalid-projection' as const,
      message: error.message,
    })),
  );
}

function checkEvidence(
  evidence: Evidence,
  path: string,
  baseline: TrackedBaseline,
  errors: ProposalError[],
): void {
  const normalized = posix.normalize(evidence.path);
  if (
    evidence.path.includes('\\') ||
    posix.isAbsolute(evidence.path) ||
    normalized !== evidence.path ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    errors.push({ path: `${path}/path`, code: 'invalid-evidence-path', message: 'evidence path must stay within the tracked repository' });
    return;
  }
  const file = baseline.snapshot.files.find((entry) => entry.path === evidence.path);
  if (!file) {
    errors.push({ path: `${path}/path`, code: 'invalid-evidence-path', message: `evidence path "${evidence.path}" is absent from the tracked snapshot` });
    return;
  }
  const expectedCommit = baseline.snapshot.dirty ? 'working-tree' : (baseline.snapshot.base_commit ?? 'working-tree');
  if (evidence.blob_hash !== file.blob_hash || evidence.commit !== expectedCommit) {
    errors.push({ path, code: 'evidence-mismatch', message: 'evidence commit/blob does not match the tracked snapshot' });
  }
}

function buildDiff(beforeNodes: Node[], afterNodes: Node[]): ProposalNodeDiff[] {
  const beforeById = new Map(beforeNodes.map((node) => [node.id, node]));
  const diff: ProposalNodeDiff[] = [];
  for (const after of afterNodes) {
    const before = beforeById.get(after.id)!;
    const beforeText = serializeNode(before);
    const afterText = serializeNode(after);
    if (beforeText !== afterText) {
      diff.push({ path: `.archmap/nodes/${after.id}.yaml`, before: beforeText, after: afterText });
    }
  }
  return diff.sort((a, b) => a.path.localeCompare(b.path));
}

function serializeNode(node: Node): string {
  return toCanonicalYaml({ schema_version: 1, ...node });
}
