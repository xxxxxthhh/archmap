/**
 * `archmap serve [--port <port>]` — run the read-only loopback viewer.
 *
 * Like `mcp`, this is a long-running command: on success it owns the process until interrupted, so
 * it returns a `CommandOutput` only when the invocation itself is a usage/environment error
 * (reported on stderr before the socket binds). It preflights the project so an unscanned repo
 * fails closed with a clear message instead of a server that rejects every request, then binds
 * `127.0.0.1` on the requested port and prints the actual bound URL to stdout.
 */

import { loadTrackedProject } from '../query/project.js';
import { startViewerServer } from '../serve/index.js';
import { takeOptionValue, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

/** Default port when `--port` is omitted. `0` (via `--port 0`) binds an ephemeral port. */
export const DEFAULT_VIEWER_PORT = 4830;

/** Parse a `--port` value into an integer in `[0, 65535]`, or return an error string. */
function parsePort(raw: string): { port: number } | { error: string } {
  if (!/^\d+$/.test(raw)) return { error: `invalid --port "${raw}"; expected an integer 0-65535` };
  const port = Number(raw);
  if (port > 65535) return { error: `invalid --port "${raw}"; expected an integer 0-65535` };
  return { port };
}

export async function runServeCommand(
  args: string[],
  ctx: CommandContext,
): Promise<CommandOutput | null> {
  const portOpt = takeOptionValue(args, '--port');
  if (portOpt.error) return usageError(false, portOpt.error);
  if (portOpt.rest.length > 0) {
    return usageError(false, `serve takes no positional arguments (got "${portOpt.rest[0]}")`);
  }

  let port = DEFAULT_VIEWER_PORT;
  if (portOpt.value !== undefined) {
    const parsed = parsePort(portOpt.value);
    if ('error' in parsed) return usageError(false, parsed.error);
    port = parsed.port;
  }

  // Preflight: a non-project / unscanned repo has nothing to serve — fail closed before binding.
  const loaded = loadTrackedProject(ctx.cwd);
  if (!loaded.ok) return usageError(false, loaded.error);

  let viewer;
  try {
    viewer = await startViewerServer({ cwd: ctx.cwd, port });
  } catch (err) {
    return usageError(false, `could not start viewer: ${(err as Error).message}`);
  }

  process.stdout.write(`archmap viewer (read-only) listening on ${viewer.url}\n`);

  // Close the socket on interrupt so the port is released promptly.
  const shutdown = (): void => {
    void viewer.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return null;
}
