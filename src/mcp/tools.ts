/**
 * The read-only MCP tool surface and its input contract.
 *
 * Each tool's JSON Schema is the single deterministic gate on its arguments: a missing, extra,
 * mistyped, empty, or out-of-range value is rejected here, before any query runs, with the same
 * message for the same input every time. The schemas are raw JSON Schema (what the protocol
 * puts on the wire), so the tool list needs no schema-generation dependency.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

// ajv ships as CJS with a `.default` export; this cast keeps the class usable under both
// `verbatimModuleSyntax` typechecking and Node ESM interop (same seam as validate/validate.ts).
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/** Rejected tool arguments (or an unknown tool name): a protocol-level invalid-params error. */
export class ToolInputError extends Error {}

const PATHS = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  description: 'Repository-relative file paths.',
};
const ID = { type: 'string', minLength: 1, description: 'A tracked id.' };
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'project_summary',
    description:
      'Scan status of the tracked model (clean/dirty, changed files, stale nodes, drift) ' +
      'together with the adapter registry and repository environment.',
    inputSchema: NO_ARGS,
  },
  {
    name: 'context_for_files',
    description:
      'Minimal evidence-backed architecture context for the given files, hard-capped at a ' +
      'token budget, with every omitted node accounted for.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: PATHS,
        budget: {
          type: 'integer',
          minimum: 1,
          description: 'Token budget for the included nodes. Defaults to 2000.',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'impact_analysis',
    description: 'Nodes affected by changing the given files, with the reason each is affected.',
    inputSchema: {
      type: 'object',
      properties: { paths: PATHS },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_architecture',
    description: 'Deterministic exact/substring search over node slug, title, scoped paths, and claim text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, description: 'Search query.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_node',
    description: 'The tracked node document for a node id.',
    inputSchema: {
      type: 'object',
      properties: { id: ID },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_evidence',
    description:
      'The re-verifiable evidence bundle (path, symbol, blob hash, commit, analyzer) for a ' +
      'node, claim, or relation id.',
    inputSchema: {
      type: 'object',
      properties: { id: ID },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_stale_nodes',
    description: 'Ids of the nodes the current working tree has made stale.',
    inputSchema: NO_ARGS,
  },
  {
    name: 'get_update_work_items',
    description:
      'One update work item per stale node: the tracked node, why it is stale, and a ' +
      'budget-capped evidence bundle.',
    inputSchema: NO_ARGS,
  },
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map<string, ValidateFunction>(
  MCP_TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);

/** Resolve a tool by name, rejecting an unknown one before anything else happens. */
export function findTool(name: string): ToolDefinition {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`unknown tool "${name}"`);
  return tool;
}

/**
 * Validate `args` against the tool's schema. Omitted arguments are the empty object, so a
 * no-argument tool works whether or not the client sends `arguments`.
 */
export function validateToolArguments(tool: ToolDefinition, args: unknown): Record<string, unknown> {
  const value = args ?? {};
  const validate = validators.get(tool.name)!;
  if (!validate(value)) {
    const detail = (validate.errors ?? [])
      .map((err) => {
        const where = err.instancePath === '' ? 'arguments' : err.instancePath;
        const extra =
          err.keyword === 'additionalProperties' ? ` (${String(err.params.additionalProperty)})` : '';
        return `${where} ${err.message ?? 'invalid'}${extra}`;
      })
      .join('; ');
    throw new ToolInputError(`invalid arguments for tool "${tool.name}": ${detail}`);
  }
  return value as Record<string, unknown>;
}
