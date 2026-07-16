import type { CheckReport, CheckViolation } from './types.js';

/** Quote arbitrary model values as inert Markdown code spans. */
function code(value: string): string {
  const quoted = JSON.stringify(value);
  const longestRun = Math.max(0, ...[...quoted.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter}${quoted}${delimiter}`;
}

function formatViolation(violation: CheckViolation): string {
  const disposition = violation.blocking ? 'blocking' : 'advisory';
  if (violation.kind === 'stale-model') {
    return `- error (${disposition}): tracked model is stale; ${violation.changed_file_count} changed file(s), ${violation.stale_node_count} stale node(s)`;
  }
  return [
    `- ${violation.severity} (${disposition}): rule ${code(violation.rule_id)}`,
    `matches ${code(violation.source_node_id)} (${code(violation.source_path)})`,
    `via ${code(violation.relation_id)} (${code(violation.relation_type)} / ${code(violation.certainty)}) -->`,
    `${code(violation.target_node_id)} (${code(violation.target_path)})`,
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
