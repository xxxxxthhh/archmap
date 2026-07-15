/**
 * Load and validate a tracked view definition, failing closed.
 *
 * A view id is used both as the `--view` selector and as the on-disk filename. The id is
 * validated against a strict slug pattern *before* it touches the filesystem, so a caller can
 * never escape `<root>/.archmap/views/` with `..`, an absolute path, or a nested segment. The
 * file itself is opened with `O_NOFOLLOW` and its `lstat` checked, so a planted symlink is
 * rejected rather than followed — the same boundary discipline the store uses. Any parse or
 * schema failure returns an error with no partial result, so an export built on a malformed or
 * malicious view never runs.
 */

import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import viewSchema from '../../schema/view.schema.json' with { type: 'json' };
import { ARCHMAP_DIR } from '../store.js';
import { DEFAULT_VIEW, VIEW_SCHEMA_VERSION, type ViewDefinition } from './types.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure: ValidateFunction = ajv.compile(viewSchema);

/** A view id must be a lowercase slug: no separators, no dots, so it cannot traverse paths. */
const VIEW_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ViewLoadResult =
  | { ok: true; view: ViewDefinition }
  | { ok: false; error: string };

/** The built-in default view, returned when `export` runs without `--view`. */
export function defaultView(): ViewLoadResult {
  return { ok: true, view: DEFAULT_VIEW };
}

/** Validate an already-parsed value as a view definition (version routing + strict schema). */
export function validateViewDocument(input: unknown, id: string): ViewLoadResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'view must be a mapping' };
  }
  const version = (input as Record<string, unknown>).schema_version;
  if (typeof version !== 'number') {
    return { ok: false, error: 'view is missing a numeric schema_version' };
  }
  if (version !== VIEW_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported view schema_version ${version}; supported: ${VIEW_SCHEMA_VERSION}`,
    };
  }
  if (!validateStructure(input)) {
    const first = (validateStructure.errors ?? [])[0];
    const where = first?.instancePath ? first.instancePath : '/';
    const extra =
      first?.keyword === 'additionalProperties'
        ? ` (${String(first.params.additionalProperty)})`
        : '';
    return { ok: false, error: `invalid view at ${where}: ${first?.message ?? 'invalid'}${extra}` };
  }
  const view = input as ViewDefinition;
  // The in-file id must match the requested id so a file cannot masquerade under another name.
  if (view.id !== id) {
    return { ok: false, error: `view id "${view.id}" does not match requested view "${id}"` };
  }
  return { ok: true, view };
}

/** Reject symlinks and read the view file with `O_NOFOLLOW`, or report why it could not be read. */
function readViewFile(path: string): { ok: true; text: string } | { ok: false; error: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'view not found' };
    }
    return { ok: false, error: 'cannot access view file' };
  }
  if (stat.isSymbolicLink()) return { ok: false, error: 'refusing to follow symlink for view file' };
  if (!stat.isFile()) return { ok: false, error: 'view path is not a regular file' };

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, error: 'cannot open view file' };
  }
  try {
    return { ok: true, text: readFileSync(fd, 'utf8') };
  } catch {
    return { ok: false, error: 'cannot read view file' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask a successful read; the descriptor is abandoned.
    }
  }
}

/**
 * Load the view `id` from `<root>/.archmap/views/<id>.yaml`. The id is validated first so a
 * malicious selector fails closed before any filesystem access.
 */
export function loadView(root: string, id: string): ViewLoadResult {
  if (!VIEW_ID_PATTERN.test(id)) {
    return { ok: false, error: `invalid view id "${id}"` };
  }
  const path = join(root, ARCHMAP_DIR, 'views', `${id}.yaml`);
  const read = readViewFile(path);
  if (!read.ok) return read;

  let parsed: unknown;
  try {
    parsed = parseYaml(read.text);
  } catch {
    return { ok: false, error: 'view is not valid YAML' };
  }
  return validateViewDocument(parsed, id);
}
