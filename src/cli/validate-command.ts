/**
 * `archmap validate <manifest> [--json]`
 *
 * Validates a manifest file and reports the outcome. The command builds a structured
 * result; the bin wrapper maps it to stdout/stderr and an exit code.
 */

import { loadManifestFile, ManifestLoadError } from '../validate/load.js';
import { validateManifest, type ValidationError } from '../validate/validate.js';

export interface CommandOutput {
  /** 0 = valid, 1 = validation errors, 2 = usage/load error. */
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ValidateReport {
  schema_version: 1;
  command: 'validate';
  path: string;
  valid: boolean;
  errors: ValidationError[];
}

const KNOWN_OPTIONS = new Set(['--json']);

export function runValidate(args: string[]): CommandOutput {
  const json = args.includes('--json');

  const unknown = args.filter((a) => a.startsWith('--') && !KNOWN_OPTIONS.has(a));
  if (unknown.length > 0) {
    return usageError(json, `unknown option(s): ${unknown.join(', ')}`);
  }

  const positionals = args.filter((a) => !a.startsWith('--'));
  if (positionals.length !== 1) {
    return usageError(json, 'validate expects exactly one manifest path');
  }
  const path = positionals[0]!;

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

function usageError(json: boolean, message: string): CommandOutput {
  if (json) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: JSON.stringify({ schema_version: 1, error: message }, null, 2) + '\n',
    };
  }
  return { exitCode: 2, stdout: '', stderr: `error: ${message}\n` };
}
