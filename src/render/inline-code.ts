/** Quote arbitrary values as inert Markdown inline-code spans. */
export function markdownInlineCode(value: string): string {
  const quoted = JSON.stringify(value);
  const longestRun = Math.max(0, ...[...quoted.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter}${quoted}${delimiter}`;
}
