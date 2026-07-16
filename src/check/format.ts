import type { CheckReport, CheckViolation } from './types.js';
import { markdownInlineCode } from '../render/inline-code.js';

function formatViolation(violation: CheckViolation): string {
  const disposition = violation.blocking ? 'blocking' : 'advisory';
  if (violation.kind === 'stale-model') {
    return `- error (${disposition}): tracked model is stale; ${violation.changed_file_count} changed file(s), ${violation.stale_node_count} stale node(s)`;
  }
  return [
    `- ${violation.severity} (${disposition}): rule ${markdownInlineCode(violation.rule_id)}`,
    `matches ${markdownInlineCode(violation.source_node_id)} (${markdownInlineCode(violation.source_path)})`,
    `via ${markdownInlineCode(violation.relation_id)} (${markdownInlineCode(violation.relation_type)} / ${markdownInlineCode(violation.certainty)}) -->`,
    `${markdownInlineCode(violation.target_node_id)} (${markdownInlineCode(violation.target_path)})`,
  ].join(' ');
}

/** Deterministic Markdown suitable for a CI summary or PR body. */
export function formatCheckMarkdown(report: CheckReport): string {
  const lines = [
    '# Archmap check',
    '',
    `Status: **${report.status}**`,
    `Mode: ${report.strict ? 'strict' : 'default'}`,
    `Summary: ${report.summary.blocking} blocking, ${report.summary.errors} error, ${report.summary.warnings} warning`,
  ];
  if (report.violations.length === 0) {
    lines.push('', 'No violations.');
  } else {
    lines.push('', '## Violations', '', ...report.violations.map(formatViolation));
  }
  return `${lines.join('\n')}\n`;
}
