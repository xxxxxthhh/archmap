import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';
import proposalSchema from '../../schema/proposal.schema.json' with { type: 'json' };
import type { Proposal, ProposalError } from './types.js';
import { PROPOSAL_SCHEMA_VERSION } from './types.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateV1Structure: ValidateFunction = ajv.compile(proposalSchema);

export type ProposalStructureResult =
  | { valid: true; proposal: Proposal; errors: [] }
  | { valid: false; errors: ProposalError[] };

export function validateProposalStructure(input: unknown): ProposalStructureResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('/', 'proposal must be an object');
  }
  const version = (input as Record<string, unknown>).proposal_schema_version;
  if (typeof version !== 'number') {
    return invalid('/proposal_schema_version', 'missing or non-numeric proposal_schema_version');
  }
  if (version !== PROPOSAL_SCHEMA_VERSION) {
    return invalid(
      '/proposal_schema_version',
      `unsupported proposal_schema_version ${version}; supported: ${PROPOSAL_SCHEMA_VERSION}`,
    );
  }
  if (!validateV1Structure(input)) {
    const errors = (validateV1Structure.errors ?? []).map((error) => ({
      path: error.instancePath === '' ? '/' : error.instancePath,
      code: 'schema' as const,
      message: `${error.message ?? 'invalid'}${
        error.keyword === 'additionalProperties'
          ? ` (${String(error.params.additionalProperty)})`
          : ''
      }`,
    }));
    return { valid: false, errors: sortErrors(errors) };
  }
  const proposal = input as Proposal;
  const shapeErrors = checkAllowedOperationShapes(proposal);
  return shapeErrors.length === 0
    ? { valid: true, proposal, errors: [] }
    : { valid: false, errors: sortErrors(shapeErrors) };
}

function checkAllowedOperationShapes(proposal: Proposal): ProposalError[] {
  const errors: ProposalError[] = [];
  proposal.operations.forEach((operation, index) => {
    const base = `/operations/${index}`;
    if (operation.op === 'add' && operation.target.class === 'claim') {
      exactTarget(operation.target, ['class', 'node_id'], base, errors);
    } else if (operation.op === 'replace' && operation.target.class === 'claim') {
      if (operation.target.field === 'status') {
        exactTarget(operation.target, ['class', 'node_id', 'id', 'field'], base, errors);
      }
    } else if (operation.op === 'add' && operation.target.class === 'relation') {
      exactTarget(operation.target, ['class', 'node_id'], base, errors);
    } else if (operation.op === 'remove' && operation.target.class === 'relation') {
      exactTarget(operation.target, ['class', 'node_id', 'id'], base, errors);
    }
  });
  return errors;
}

function exactTarget(
  target: Proposal['operations'][number]['target'],
  required: string[],
  base: string,
  errors: ProposalError[],
): void {
  for (const key of required) {
    if (!(key in target)) {
      errors.push({ path: `${base}/target`, code: 'schema', message: `must include ${key}` });
    }
  }
  for (const key of Object.keys(target)) {
    if (!required.includes(key)) {
      errors.push({ path: `${base}/target/${key}`, code: 'schema', message: 'field is not valid for this operation' });
    }
  }
}

function invalid(path: string, message: string): ProposalStructureResult {
  return { valid: false, errors: [{ path, code: 'schema', message }] };
}

export function sortErrors(errors: ProposalError[]): ProposalError[] {
  return [...errors].sort(
    (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}
