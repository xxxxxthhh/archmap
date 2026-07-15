/**
 * Content-safety neutralization for untrusted free-text model fields.
 *
 * Node `title`, claim `text`, and evidence pointer strings originate from analyzers, agents, or
 * humans and are only length/shape-constrained by the model schema — a title or claim body may
 * contain arbitrary markup. Issue #28 requires every export (Mermaid, Markdown, SVG) *and* the
 * `--json` envelope to carry only safe metadata, never active Markdown/HTML/resource syntax and
 * never bulk source content. Rather than escape per-format (which would still leave raw payloads
 * in the JSON projection consumed by the browser map and diff mode), the projection neutralizes
 * these fields once, at the source, so no downstream format can reintroduce an active construct.
 *
 * The transform is conservative and deterministic: control characters and whitespace are
 * collapsed, length is bounded, URL schemes are broken so nothing auto-links or fetches a remote
 * resource, and the characters that form tags, HTML entities, links, images, code spans, and
 * label break-outs are replaced with inert visual homoglyphs. Ordinary text (ASCII words,
 * punctuation, CJK) passes through unchanged, so normal titles and claims render as before.
 */

/** Upper bound on any single rendered field, so a claim can never dump bulk/source content. */
export const MAX_FIELD_CHARS = 500;

/**
 * Syntax-significant characters mapped to inert look-alikes:
 *   `<` `>`  tags / autolinks                 -> guillemets
 *   `&`      HTML entities (e.g. `&#60;`)     -> fullwidth ampersand
 *   `"`      attribute / Mermaid-label quote  -> fullwidth quote
 *   `` ` ``  code spans                       -> right single quote
 *   `[` `]`  links / images `![x](url)`       -> mathematical brackets
 *   `#`      Mermaid numeric entities `#34;`  -> fullwidth number sign
 */
const HOMOGLYPHS: Record<string, string> = {
  '<': '‹',
  '>': '›',
  '&': '＆',
  '"': '＂',
  '`': '’',
  '[': '⟦',
  ']': '⟧',
  '#': '＃',
};

const ACTIVE_CHARS = /[<>&"`[\]#]/g;
const URL_SCHEME = /:\/\//g;

/** True for C0/DEL control code points, which must never survive into a rendered field. */
function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

/**
 * Neutralize an untrusted field for safe emission in every export format. Returns inert,
 * human-readable text with no active markup, no remote-resource syntax, and bounded length.
 */
export function neutralizeText(raw: string, maxChars = MAX_FIELD_CHARS): string {
  // Replace control characters with spaces via code-point iteration (no control-literal regex).
  let text = Array.from(raw, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('');
  text = text.replace(/\s+/g, ' ').trim();
  // Break `scheme://` so a bare or parenthesized URL cannot auto-link or load a remote resource.
  text = text.replace(URL_SCHEME, '꞉//');
  text = text.replace(ACTIVE_CHARS, (c) => HOMOGLYPHS[c] ?? c);
  // Bound by code points so a surrogate pair (e.g. an emoji) is never split mid-character.
  const chars = [...text];
  if (chars.length > maxChars) return `${chars.slice(0, maxChars - 1).join('')}…`;
  return text;
}
