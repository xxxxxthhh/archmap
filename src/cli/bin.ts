#!/usr/bin/env node
/** archmap CLI entry point. Dispatches subcommands and owns exit-code mapping. */

import { runValidate } from './validate-command.js';

const USAGE = `archmap <command> [options]

Commands:
  validate <manifest> [--json]   Validate a manifest file (YAML or JSON)
`;

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  switch (command) {
    case 'validate': {
      const out = runValidate(rest);
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
      process.exitCode = out.exitCode;
      return;
    }
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      process.exitCode = command === undefined ? 2 : 0;
      return;
    default:
      process.stderr.write(`error: unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2));
