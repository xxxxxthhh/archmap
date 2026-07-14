/**
 * Runtime validation for the persisted `project.yaml`, `snapshot.yaml`, and node documents.
 *
 * These files are read back on every command, so a malformed or future-version file must
 * fail loudly rather than being cast blindly. Each parse: (1) parses YAML, (2) routes on
 * `schema_version` — an unsupported version is a clear error, not a schema mismatch — and
 * (3) validates structure against the tracked JSON Schema.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import projectSchema from '../../schema/project.schema.json' with { type: 'json' };
import snapshotSchema from '../../schema/snapshot.schema.json' with { type: 'json' };
import nodeSchema from '../../schema/node.schema.json' with { type: 'json' };
import type { Node } from '../model/types.js';
import type { ProjectConfig, Snapshot } from '../scan/types.js';
import { StoreFormatError } from '../store-errors.js';

export { StoreFormatError } from '../store-errors.js';

const SUPPORTED_VERSION = 1;

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateProjectStructure: ValidateFunction = ajv.compile(projectSchema);
const validateSnapshotStructure: ValidateFunction = ajv.compile(snapshotSchema);
const validateNodeStructure: ValidateFunction = ajv.compile(nodeSchema);

function parseVersioned(kind: string, text: string, validate: ValidateFunction): object {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    throw new StoreFormatError(`malformed ${kind}: not valid YAML`, { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StoreFormatError(`malformed ${kind}: expected an object`);
  }
  const version = (parsed as Record<string, unknown>).schema_version;
  if (version !== SUPPORTED_VERSION) {
    throw new StoreFormatError(
      `unsupported ${kind} schema_version ${String(version)}; supported: ${SUPPORTED_VERSION}`,
    );
  }
  if (!validate(parsed)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
    throw new StoreFormatError(`invalid ${kind}: ${detail}`);
  }
  return parsed;
}

export function parseProjectConfig(text: string): ProjectConfig {
  return parseVersioned('project.yaml', text, validateProjectStructure) as unknown as ProjectConfig;
}

export function parseSnapshot(text: string): Snapshot {
  const snapshot = parseVersioned('snapshot.yaml', text, validateSnapshotStructure) as unknown as Snapshot;
  // A file path is the snapshot's identity for a record; a duplicate (even with differing
  // fields) is a corrupt ledger that would let a diff silently collapse the collision.
  assertUnique(
    snapshot.files.map((f) => f.path),
    (path) => `invalid snapshot.yaml: duplicate file path "${path}"`,
  );
  // Nested by id → version so no string delimiter can collide two distinct identities
  // (e.g. id "a@"/version "b" vs id "a"/version "@b").
  const capsById = new Map<string, Set<string>>();
  for (const cap of snapshot.capabilities) {
    let versions = capsById.get(cap.id);
    if (!versions) {
      versions = new Set();
      capsById.set(cap.id, versions);
    }
    if (versions.has(cap.version)) {
      throw new StoreFormatError(
        `invalid snapshot.yaml: duplicate capability "${cap.id}" version "${cap.version}"`,
      );
    }
    versions.add(cap.version);
  }
  return snapshot;
}

function assertUnique(keys: string[], message: (key: string) => string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new StoreFormatError(message(key));
    seen.add(key);
  }
}

/** Parse and validate a tracked node document, returning the `Node` without its version tag. */
export function parseNodeDocument(text: string): Node {
  const doc = parseVersioned('node document', text, validateNodeStructure) as Record<string, unknown>;
  const { schema_version, ...node } = doc;
  return node as unknown as Node;
}
