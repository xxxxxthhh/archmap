/** Minimal shared option parsing for the CLI: an allowlist of flags plus positionals. */

import type { CommandOutput } from './types.js';

export interface ParsedOptions {
  json: boolean;
  flags: Set<string>;
  positionals: string[];
  /** Set when an unrecognized `--flag` was passed. */
  error?: string;
}

/** Parse `args`, rejecting any `--flag` not in `allowed` (guards against typos like `--jso`). */
export function parseOptions(args: string[], allowed: readonly string[]): ParsedOptions {
  const allowSet = new Set(allowed);
  const flags = new Set<string>();
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (const arg of args) {
    // Any leading-dash token is an option, so a mistyped `-x` or `--jso` is rejected rather
    // than silently swallowed as a positional.
    if (arg.startsWith('-')) {
      if (allowSet.has(arg)) flags.add(arg);
      else unknown.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  const parsed: ParsedOptions = { json: flags.has('--json'), flags, positionals };
  if (unknown.length > 0) parsed.error = `unknown option(s): ${unknown.join(', ')}`;
  return parsed;
}

/**
 * Extract a valued option (`--name value` or `--name=value`) from `args`, returning the value
 * (if present) and the remaining args. A trailing `--name` with no value is an error.
 */
export function takeOptionValue(
  args: string[],
  name: string,
): { value?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === name) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) return { rest, error: `${name} requires a value` };
      value = next;
      i += 1;
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return value === undefined ? { rest } : { value, rest };
}

/** Build a usage-error result (exit code 2), JSON- or text-shaped. */
export function usageError(json: boolean, message: string): CommandOutput {
  if (json) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${JSON.stringify({ schema_version: 1, error: message }, null, 2)}\n`,
    };
  }
  return { exitCode: 2, stdout: '', stderr: `error: ${message}\n` };
}
