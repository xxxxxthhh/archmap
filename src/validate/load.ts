/**
 * Manifest file loading. Accepts YAML (`.yaml`/`.yml`) or JSON (`.json`) and returns the
 * parsed value; validation is a separate step so the loader stays purely I/O + parse.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';

export class ManifestLoadError extends Error {}

/** Read and parse a manifest file into an untyped value ready for validation. */
export function loadManifestFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ManifestLoadError(`cannot read manifest file: ${path}`, { cause });
  }

  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.json') {
      return JSON.parse(raw);
    }
    if (ext === '.yaml' || ext === '.yml') {
      return parseYaml(raw);
    }
  } catch (cause) {
    throw new ManifestLoadError(`cannot parse manifest file: ${path}`, { cause });
  }
  throw new ManifestLoadError(`unsupported manifest extension "${ext}" (${path})`);
}
