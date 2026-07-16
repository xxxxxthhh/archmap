/** `archmap workspace index <member...> [--json]` — aggregate persisted child baselines. */

import { toCanonicalJson } from '../model/canonical.js';
import { markdownInlineCode } from '../render/inline-code.js';
import { writeWorkspaceIndex } from '../store.js';
import { StoreError } from '../store-errors.js';
import { buildWorkspaceIndex } from '../workspace/index.js';
import type { WorkspaceIndex } from '../workspace/types.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

function formatMarkdown(index: WorkspaceIndex): string {
  const lines = [
    '# Archmap workspace index',
    '',
    `Summary: ${index.summary.member_count} member(s), ${index.summary.node_count} node(s)`,
    '',
    '## Members',
    '',
    ...index.members.map((member) =>
      `- ${markdownInlineCode(member.path)}: ${markdownInlineCode(member.project_id)} / ${markdownInlineCode(member.project_name)} (${member.node_count} node(s), ${member.dirty ? 'dirty snapshot' : 'clean snapshot'})`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function runWorkspaceCommand(args: string[], ctx: CommandContext): CommandOutput {
  const [mode, ...rest] = args;
  if (mode !== 'index') {
    return usageError(args.includes('--json'), 'workspace expects `index`');
  }

  const opts = parseOptions(rest, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const loaded = loadScannedProject(ctx, opts.json);
  if (!loaded.ok) return loaded.out;

  try {
    const index = buildWorkspaceIndex(loaded.root, opts.positionals);
    writeWorkspaceIndex(loaded.root, index);
    return {
      exitCode: 0,
      stdout: opts.json ? toCanonicalJson(index) : formatMarkdown(index),
      stderr: '',
    };
  } catch (error) {
    if (error instanceof StoreError) return usageError(opts.json, error.message);
    throw error;
  }
}
