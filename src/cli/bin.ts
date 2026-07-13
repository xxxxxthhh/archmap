#!/usr/bin/env node
/** archmap CLI entry point. Dispatches subcommands and owns exit-code mapping. */

import { runCapabilitiesCommand } from './capabilities-command.js';
import { runContextCommand } from './context-command.js';
import { runEvidenceCommand } from './evidence-command.js';
import { runImpactCommand } from './impact-command.js';
import { runInit } from './init-command.js';
import { runScanCommand } from './scan-command.js';
import { runStatusCommand } from './status-command.js';
import type { CommandContext, CommandOutput } from './types.js';
import { runValidate } from './validate-command.js';

const USAGE = `archmap <command> [options]

Commands:
  init [--json]                        Initialize an .archmap project
  scan [--changed] [--json]            Rebuild the snapshot, nodes, and derived index
  status [--json]                      Report changed files and stale nodes
  capabilities [--json]                List adapters and repository environment
  context <path...> [--budget <n>] [--json]  Minimal evidence-backed context for files
  impact <path...> [--base <ref>] [--json]    Nodes affected by changing files
  evidence <id> [--json]               Evidence bundle for a node/claim/relation id
  validate <manifest> [--json]         Validate a manifest file (YAML or JSON)
`;

function dispatch(command: string | undefined, rest: string[], ctx: CommandContext): CommandOutput | null {
  switch (command) {
    case 'init':
      return runInit(rest, ctx);
    case 'scan':
      return runScanCommand(rest, ctx);
    case 'status':
      return runStatusCommand(rest, ctx);
    case 'capabilities':
      return runCapabilitiesCommand(rest, ctx);
    case 'context':
      return runContextCommand(rest, ctx);
    case 'impact':
      return runImpactCommand(rest, ctx);
    case 'evidence':
      return runEvidenceCommand(rest, ctx);
    case 'validate':
      return runValidate(rest);
    default:
      return null;
  }
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const ctx: CommandContext = { cwd: process.cwd() };

  const out = dispatch(command, rest, ctx);
  if (out) {
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    process.exitCode = out.exitCode;
    return;
  }

  if (command === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`error: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}

main(process.argv.slice(2));
