#!/usr/bin/env node
/** archmap CLI entry point. Dispatches subcommands and owns exit-code mapping. */

import { runCapabilitiesCommand } from './capabilities-command.js';
import { runContextCommand } from './context-command.js';
import { runDiffCommand } from './diff-command.js';
import { runEvidenceCommand } from './evidence-command.js';
import { runExportCommand } from './export-command.js';
import { runImpactCommand } from './impact-command.js';
import { runInit } from './init-command.js';
import { runMcpCommand } from './mcp-command.js';
import { runNodeCommand } from './node-command.js';
import { runProposalDispatch } from './proposal-command.js';
import { runScanCommand } from './scan-command.js';
import { runSearchCommand } from './search-command.js';
import { runStatusCommand } from './status-command.js';
import type { CommandContext, CommandOutput } from './types.js';
import { runValidate } from './validate-command.js';
import { runWorkItemsCommand } from './work-items-command.js';

const USAGE = `archmap <command> [options]

Commands:
  init [--json]                        Initialize an .archmap project
  scan [--changed] [--json]            Rebuild the snapshot, nodes, and derived index
  status [--json]                      Report changed files and stale nodes
  capabilities [--json]                List adapters and repository environment
  context <path...> [--budget <n>] [--json]  Minimal evidence-backed context for files
  impact <path...> [--base <ref>] [--json]    Nodes affected by changing files
  diff <base> [head] [--json]          Architecture diff of tracked state between two commits
  node <id> [--json]                   Tracked node document for a node id
  evidence <id> [--json]               Evidence bundle for a node/claim/relation id
  work-items [--json]                  Stale-node update work items with bounded evidence
  search <query> [--json]              Search slug, title, paths, and claim text
  mcp                                  Serve the query and guarded proposal tools over stdio (MCP)
  proposal validate <file> [--json]    Validate an external proposal without writing
  proposal preview <file> [--json]     Preview its canonical tracked-node diff without writing
  proposal apply <file> [--approve <conflict-id>]... [--json]
                                       Atomically publish validated node enrichment
  validate <manifest> [--json]         Validate a manifest file (YAML or JSON)
  export --format mermaid|markdown|svg [--view <id>] [--json]
                                       Render a deterministic view projection of the model
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
    case 'diff':
      return runDiffCommand(rest, ctx);
    case 'node':
      return runNodeCommand(rest, ctx);
    case 'evidence':
      return runEvidenceCommand(rest, ctx);
    case 'work-items':
      return runWorkItemsCommand(rest, ctx);
    case 'search':
      return runSearchCommand(rest, ctx);
    case 'proposal':
      return runProposalDispatch(rest, ctx);
    case 'validate':
      return runValidate(rest);
    case 'export':
      return runExportCommand(rest, ctx);
    default:
      return null;
  }
}

function emit(out: CommandOutput): void {
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const ctx: CommandContext = { cwd: process.cwd() };

  // `mcp` is the only long-running command: it owns stdout as a JSON-RPC channel until the
  // client disconnects, so it cannot use the buffered single-output path. It returns an output
  // only when the invocation itself is a usage error.
  if (command === 'mcp') {
    const usage = await runMcpCommand(rest, ctx);
    if (usage) emit(usage);
    return;
  }

  const out = dispatch(command, rest, ctx);
  if (out) {
    emit(out);
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

// An unexpected error stays fatal and unmasked, exactly as it was when `main` was synchronous.
void main(process.argv.slice(2));
