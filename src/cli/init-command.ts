/**
 * `archmap init [--json]`
 *
 * Creates `.archmap/` with a default `project.yaml` at the git top level (or the current
 * directory when not in a git repo). Idempotent: re-running reports the existing project
 * rather than overwriting it.
 */

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SECRET_GLOBS,
} from '../scan/exclude.js';
import { repoToplevel } from '../scan/git.js';
import type { ProjectConfig } from '../scan/types.js';
import { isInitialized, paths, writeProject } from '../store.js';
import { StoreError } from '../store-errors.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

function defaultConfig(name: string): ProjectConfig {
  return {
    schema_version: 1,
    project: {
      id: `proj_${randomBytes(6).toString('hex')}`,
      name,
    },
    scan: {
      max_file_bytes: DEFAULT_MAX_FILE_BYTES,
      exclude_dirs: [...DEFAULT_EXCLUDE_DIRS],
      secret_globs: [...DEFAULT_SECRET_GLOBS],
    },
  };
}

export function runInit(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length > 0) {
    return usageError(json, 'init takes no positional arguments');
  }

  const root = repoToplevel(ctx.cwd) ?? ctx.cwd;
  const config = defaultConfig(basename(root));

  try {
    if (isInitialized(root)) {
      const message = `already initialized: ${paths.dir(root)}`;
      return json
        ? ok(`${JSON.stringify({ schema_version: 1, command: 'init', initialized: true, root }, null, 2)}\n`)
        : ok(`${message}\n`);
    }
    writeProject(root, config);
  } catch (err) {
    if (err instanceof StoreError) return usageError(json, err.message);
    throw err;
  }

  if (json) {
    return ok(
      `${JSON.stringify(
        { schema_version: 1, command: 'init', initialized: true, root, project: config.project },
        null,
        2,
      )}\n`,
    );
  }
  return ok(`initialized archmap project "${config.project.name}" at ${paths.dir(root)}\n`);
}

function ok(stdout: string): CommandOutput {
  return { exitCode: 0, stdout, stderr: '' };
}
