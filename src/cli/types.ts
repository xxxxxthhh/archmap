/** Shared CLI command contract. Commands are pure: they compute output + an exit code and
 * leave all process I/O to the bin wrapper (PLAN 8.1). */

export interface CommandOutput {
  /** 0 = success, 1 = domain failure (invalid/stale), 2 = usage/environment error. */
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/** Options every command receives from the bin wrapper. */
export interface CommandContext {
  cwd: string;
}
