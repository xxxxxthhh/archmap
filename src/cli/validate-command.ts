/**
 * `archmap validate <manifest> [--json]`
 *
 * Validates a manifest file and reports the outcome. The command builds a structured
 * result; the bin wrapper maps it to stdout/stderr and an exit code.
 */

import { loadManifestFile, ManifestLoadError } from '../validate/load.js';
import { validateManifest, type ValidationError } from '../validate/validate.js';
import { parseOptions, usageError } from './options.js';
import type { CommandOutput } from './types.js';

interface ValidateReport {
  schema_version: 1;
  command: 'validate';
  path: string;
  valid: boolean;
  errors: ValidationError[];
}

export function runValidate(args: string[]): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length !== 1) {
    return usageError(json, 'validate expects exactly one manifest path');
  }
  const path = opts.positionals[0]!;

  let parsed: unknown;
  try {
    parsed = loadManifestFile(path);
  } catch (err) {
    if (err instanceof ManifestLoadError) {
      return usageError(json, err.message);
    }
    throw err;
  }

  const result = validateManifest(parsed);

  if (json) {
    const report: ValidateReport = {
      schema_version: 1,
      command: 'validate',
      path,
      valid: result.valid,
      errors: result.errors,
    };
    return {
      exitCode: result.valid ? 0 : 1,
      stdout: JSON.stringify(report, null, 2) + '\n',
      stderr: '',
    };
  }

  if (result.valid) {
    return { exitCode: 0, stdout: `ok: ${path} is a valid manifest\n`, stderr: '' };
  }

  const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`);
  return {
    exitCode: 1,
    stdout: '',
    stderr: `invalid: ${path} has ${result.errors.length} error(s)\n${lines.join('\n')}\n`,
  };
}
