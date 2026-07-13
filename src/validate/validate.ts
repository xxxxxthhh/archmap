/**
 * Manifest validation.
 *
 * Layers:
 *   1. Version routing — read `schema_version` first and dispatch to a version-specific
 *      validator. Unsupported versions fail here without touching any version schema; this
 *      is the migration seam later schema versions plug into.
 *   2. Structural — the tracked JSON Schema, enforced with Ajv.
 *   3. Semantic — cross-document rules the schema cannot express: id uniqueness, relation
 *      reference integrity, provenance/type consistency, and evidence↔capability linkage.
 *
 * The core library never calls `process.exit`; it returns a structured result and lets the
 * CLI layer map it to an exit code (PLAN 8.1).
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';
import schema from '../../schema/manifest.schema.json' with { type: 'json' };
import type { Capability, Claim, Evidence, Manifest, Node } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';

/** A single validation problem, addressed by a JSON-pointer-ish path. */
export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Schema versions this build can validate. */
const SUPPORTED_VERSIONS: readonly number[] = [SCHEMA_VERSION];

// ajv and ajv-formats ship as CJS with a `.default` export; these casts keep the class /
// function usable under both `verbatimModuleSyntax` typechecking and Node ESM interop.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateV1Structure: ValidateFunction = ajv.compile(schema);

/** Validate an already-parsed value as a manifest, routing on `schema_version`. */
export function validateManifest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('/', 'manifest must be an object');
  }

  const version = (input as Record<string, unknown>).schema_version;
  if (typeof version !== 'number') {
    return fail('/schema_version', 'missing or non-numeric schema_version');
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return fail(
      '/schema_version',
      `unsupported schema_version ${version}; supported: ${SUPPORTED_VERSIONS.join(', ')}`,
    );
  }

  return validateV1(input);
}

function validateV1(input: object): ValidationResult {
  const errors: ValidationError[] = [];

  if (!validateV1Structure(input)) {
    for (const err of validateV1Structure.errors ?? []) {
      errors.push({
        path: err.instancePath === '' ? '/' : err.instancePath,
        message: `${err.message ?? 'invalid'}${
          err.keyword === 'additionalProperties'
            ? ` (${String(err.params.additionalProperty)})`
            : ''
        }`,
      });
    }
    // Structural failure short-circuits: semantic checks assume a well-formed shape.
    return { valid: false, errors };
  }

  const manifest = input as Manifest;
  const errs = checkSemantics(manifest);
  return { valid: errs.length === 0, errors: errs };
}

function checkSemantics(manifest: Manifest): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeIds = new Set<string>();
  const seenIds = new Set<string>();
  const capabilities = indexCapabilities(manifest.capabilities, errors);

  // First pass: collect node ids and flag any id reused across nodes, claims, or relations.
  manifest.nodes.forEach((node, i) => {
    nodeIds.add(node.id);
    registerId(seenIds, errors, node.id, `/nodes/${i}/id`);
    node.claims.forEach((claim, ci) => {
      registerId(seenIds, errors, claim.id, `/nodes/${i}/claims/${ci}/id`);
    });
    node.relations.forEach((rel, ri) => {
      registerId(seenIds, errors, rel.id, `/nodes/${i}/relations/${ri}/id`);
    });
  });

  // Second pass: entity-level rules.
  manifest.nodes.forEach((node, i) => {
    node.claims.forEach((claim, ci) => {
      const base = `/nodes/${i}/claims/${ci}`;
      checkProvenance(claim, base, errors);
      // A `fact` is deterministic and may only rest on a supported capability.
      claim.evidence.forEach((ev, ei) => {
        checkEvidenceCapability(
          ev,
          `${base}/evidence/${ei}`,
          capabilities,
          claim.type === 'fact',
          errors,
        );
      });
    });
    checkRelations(node, i, nodeIds, capabilities, errors);
  });

  return errors;
}

/** id -> version -> capability. Nested so no string delimiter can collide two identities. */
type CapabilityIndex = Map<string, Map<string, Capability>>;

/**
 * Build the capability lookup. A duplicate `(id, version)` is rejected rather than silently
 * overwritten — otherwise validity would depend on declaration order (e.g. a later
 * `supported` entry masking an earlier `partial` one).
 */
function indexCapabilities(
  capabilities: Capability[],
  errors: ValidationError[],
): CapabilityIndex {
  const index: CapabilityIndex = new Map();
  capabilities.forEach((cap, i) => {
    let byVersion = index.get(cap.id);
    if (!byVersion) {
      byVersion = new Map();
      index.set(cap.id, byVersion);
    }
    if (byVersion.has(cap.version)) {
      errors.push({
        path: `/capabilities/${i}`,
        message: `duplicate capability "${cap.id}@${cap.version}"`,
      });
      return;
    }
    byVersion.set(cap.version, cap);
  });
  return index;
}

function registerId(
  seen: Set<string>,
  errors: ValidationError[],
  id: string,
  path: string,
): void {
  if (seen.has(id)) {
    errors.push({ path, message: `duplicate id "${id}"` });
  }
  seen.add(id);
}

/** Enforce the Facts/Interpretations boundary via provenance (PLAN 3.1). */
function checkProvenance(claim: Claim, base: string, errors: ValidationError[]): void {
  const actor = claim.provenance.actor;

  if (claim.type === 'fact' && actor !== 'analyzer') {
    errors.push({
      path: `${base}/provenance/actor`,
      message: `fact claims must be produced by an analyzer, not "${actor}"`,
    });
  }
  if (claim.type === 'inference' && actor === 'analyzer') {
    errors.push({
      path: `${base}/provenance/actor`,
      message: 'inference claims cannot be produced by an analyzer',
    });
  }
  if (claim.provenance.model !== undefined && actor !== 'agent') {
    errors.push({
      path: `${base}/provenance/model`,
      message: `provenance.model may only be set when actor is "agent", not "${actor}"`,
    });
  }
}

/**
 * Every piece of evidence must name a declared capability. When `deterministic` is true
 * (a `fact` claim or a `known` relation) the capability must additionally be `supported`:
 * a `partial`/`unsupported` capability must never be promoted to a deterministic assertion
 * (PLAN 10, 13.3).
 */
function checkEvidenceCapability(
  ev: Evidence,
  path: string,
  capabilities: CapabilityIndex,
  deterministic: boolean,
  errors: ValidationError[],
): void {
  const cap = capabilities.get(ev.analyzer)?.get(ev.analyzer_version);
  if (!cap) {
    errors.push({
      path,
      message: `evidence analyzer "${ev.analyzer}@${ev.analyzer_version}" is not a declared capability`,
    });
    return;
  }
  if (deterministic && cap.status !== 'supported') {
    errors.push({
      path,
      message: `deterministic evidence requires a supported capability, but "${ev.analyzer}@${ev.analyzer_version}" is "${cap.status}"`,
    });
  }
}

function checkRelations(
  node: Node,
  nodeIndex: number,
  nodeIds: Set<string>,
  capabilities: CapabilityIndex,
  errors: ValidationError[],
): void {
  node.relations.forEach((rel, ri) => {
    const base = `/nodes/${nodeIndex}/relations/${ri}`;
    const deterministic = rel.certainty === 'known';

    if (!nodeIds.has(rel.target)) {
      errors.push({
        path: `${base}/target`,
        message: `relation target "${rel.target}" does not reference a known node`,
      });
    }

    // A `known` relation is a deterministic assertion and must be re-verifiable.
    // `partial`/`unknown` relations are allowed to lack evidence by design.
    if (deterministic && (rel.evidence?.length ?? 0) === 0) {
      errors.push({
        path: `${base}/evidence`,
        message: 'relation with certainty "known" requires at least one evidence entry',
      });
    }

    rel.evidence?.forEach((ev, ei) => {
      // Relation certainty (not claim type) governs determinism here.
      checkEvidenceCapability(ev, `${base}/evidence/${ei}`, capabilities, deterministic, errors);
    });
  });
}

function fail(path: string, message: string): ValidationResult {
  return { valid: false, errors: [{ path, message }] };
}
