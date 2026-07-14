/**
 * Content-safe Markdown docs projection.
 *
 * This is deliberately a bounded CommonMark subset, not a renderer: repository content is
 * never executed, HTML is never rendered, and destinations are never fetched. It recognizes ATX
 * headings, one-line reference definitions/uses, inline links/images, and HTTP(S) autolinks
 * after masking fenced and inline code. A `depends-on` relation on a docs node means “this
 * document references this target” under schema v1's existing vocabulary.
 */

import { dirname } from 'node:path/posix';
import { MARKDOWN_ADAPTER_VERSION, MARKDOWN_CAPABILITY } from '../capabilities.js';
import type { Capability, Claim, Evidence, Node, Provenance, Relation } from '../model/types.js';
import { hashContent } from '../scan/hash.js';
import { containingNodeId, nodeId, slugFor } from '../scan/nodes.js';
import type { Discovery } from '../scan/types.js';
import { ScanInputError } from '../store-errors.js';
import { isMarkdown } from './languages.js';

const ANALYZER = 'markdown';
const PROVENANCE: Provenance = { actor: 'analyzer', created_at: '1970-01-01T00:00:00Z' };

export { MARKDOWN_CAPABILITY };

export interface MarkdownModelResult {
  capability: Capability;
  nodes: Node[];
}

interface Heading {
  level: number;
  text: string;
}

interface MarkdownAnalysis {
  headings: Heading[];
  destinations: string[];
}

const shortHash = (key: string): string =>
  hashContent(Buffer.from(key)).slice('sha256:'.length, 'sha256:'.length + 16);
const docNodeId = (path: string): string => nodeId(`doc:${path}`);
const externalNodeId = (destination: string): string => nodeId(`external:markdown:${destination}`);
const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

function blank(text: string): string {
  return ' '.repeat(text.length);
}

/** Remove deterministic leading YAML front matter without parsing or executing it. */
function maskFrontMatter(lines: string[]): void {
  if (lines[0] !== '---') return;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---' || lines[index] === '...') {
      for (let masked = 0; masked <= index; masked += 1) lines[masked] = blank(lines[masked]!);
      return;
    }
  }
}

/** Mask CommonMark-style fenced blocks (up to three leading spaces, backtick or tilde). */
function maskFences(lines: string[]): void {
  let fence: { marker: '`' | '~'; width: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!fence) {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!opening) continue;
      fence = { marker: opening[1]![0] as '`' | '~', width: opening[1]!.length };
      lines[index] = blank(line);
      continue;
    }
    const closing = new RegExp(`^ {0,3}\\${fence.marker}{${fence.width},}[ \\t]*$`);
    lines[index] = blank(line);
    if (closing.test(line)) fence = null;
  }
}

/** Mask matching inline-code spans (including multiline spans) while preserving line breaks. */
function maskInlineCode(lines: string[]): void {
  const source = lines.join('\n');
  const chars = source.split('');
  for (let index = 0; index < chars.length; ) {
    if (chars[index] !== '`') {
      index += 1;
      continue;
    }
    let width = 1;
    while (chars[index + width] === '`') width += 1;
    let closing = index + width;
    for (;;) {
      closing = source.indexOf('`'.repeat(width), closing);
      if (closing === -1) break;
      if (source[closing - 1] !== '`' && source[closing + width] !== '`') {
        for (let masked = index; masked < closing + width; masked += 1) {
          if (chars[masked] !== '\n') chars[masked] = ' ';
        }
        index = closing + width;
        break;
      }
      closing += width;
    }
    if (closing === -1) index += width;
  }
  const masked = chars.join('').split('\n');
  for (let index = 0; index < lines.length; index += 1) lines[index] = masked[index]!;
}

function isEscaped(line: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function closingBracket(line: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '[') depth += 1;
    if (line[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Parse the destination at the start of a link destination/reference-definition tail. */
function destinationAt(source: string): string | null {
  const input = source.trimStart();
  if (input.startsWith('<')) {
    const close = input.indexOf('>');
    if (close <= 1) return null;
    const destination = input.slice(1, close);
    return /[<>\n]/.test(destination) ? null : destination;
  }
  let depth = 0;
  let escaped = false;
  let end = 0;
  for (; end < input.length; end += 1) {
    const char = input[end]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === ' ' || char === '\t') && depth === 0) break;
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (end === 0 || depth !== 0) return null;
  return input.slice(0, end);
}

interface InlineDestination {
  destination: string;
  /** Characters consumed from `source`, including optional title and the outer `)`. */
  consumed: number;
}

/** Inline links additionally require their outer `)`; malformed link-like text is ignored. */
function inlineDestinationAt(source: string): InlineDestination | null {
  const input = source.trimStart();
  const leadingWhitespace = source.length - input.length;
  let destination: string;
  let end: number;
  if (input.startsWith('<')) {
    end = input.indexOf('>');
    if (end <= 1) return null;
    destination = input.slice(1, end);
    if (/[<>\n]/.test(destination)) return null;
    end += 1;
  } else {
    let depth = 0;
    let escaped = false;
    for (end = 0; end < input.length; end += 1) {
      const char = input[end]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if ((char === ' ' || char === '\t') && depth === 0) break;
      if (char === '(') depth += 1;
      if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (end === 0 || depth !== 0) return null;
    destination = input.slice(0, end);
  }

  let cursor = end;
  while (input[cursor] === ' ' || input[cursor] === '\t') cursor += 1;
  if (input[cursor] === ')') {
    return { destination, consumed: leadingWhitespace + cursor + 1 };
  }
  const opener = input[cursor];
  const closer = opener === '(' ? ')' : opener;
  if (opener !== '"' && opener !== "'" && opener !== '(') return null;
  let escaped = false;
  let close = -1;
  for (let index = cursor + 1; index < input.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (input[index] === '\\') {
      escaped = true;
      continue;
    }
    if (input[index] === closer) {
      close = index;
      break;
    }
  }
  if (close === -1) return null;
  cursor = close + 1;
  while (input[cursor] === ' ' || input[cursor] === '\t') cursor += 1;
  return input[cursor] === ')'
    ? { destination, consumed: leadingWhitespace + cursor + 1 }
    : null;
}

function referenceDefinitions(lines: string[]): { definitions: Map<string, string>; definitionLines: Set<number> } {
  const definitions = new Map<string, string>();
  const definitionLines = new Set<number>();
  lines.forEach((line, index) => {
    const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line);
    if (!match) return;
    const destination = destinationAt(match[2]!);
    const label = normalizeLabel(match[1]!);
    if (!destination || !label) return;
    if (!definitions.has(label)) definitions.set(label, destination);
    definitionLines.add(index);
  });
  return { definitions, definitionLines };
}

function inlineDestinations(
  line: string,
  definitions: ReadonlyMap<string, string>,
): { destinations: string[]; autolinkSource: string } {
  const destinations: string[] = [];
  const autolinkSource = line.split('');
  for (let index = 0; index < line.length; index += 1) {
    const image = line[index] === '!' && line[index + 1] === '[';
    if (line[index] !== '[' && !image) continue;
    const opening = image ? index + 1 : index;
    if (isEscaped(line, opening)) continue;
    const close = closingBracket(line, opening);
    if (close === -1) continue;
    const label = line.slice(opening + 1, close);
    const next = line[close + 1];
    if (next === '(') {
      const parsed = inlineDestinationAt(line.slice(close + 2));
      if (parsed) {
        destinations.push(parsed.destination);
        const consumedEnd = close + 2 + parsed.consumed;
        for (let masked = index; masked < consumedEnd; masked += 1) autolinkSource[masked] = ' ';
        index = consumedEnd - 1;
        continue;
      }
    } else if (next === '[') {
      const refClose = closingBracket(line, close + 1);
      if (refClose !== -1) {
        const explicit = line.slice(close + 2, refClose);
        const destination = definitions.get(normalizeLabel(explicit || label));
        if (destination) {
          destinations.push(destination);
          const consumedEnd = refClose + 1;
          for (let masked = index; masked < consumedEnd; masked += 1) autolinkSource[masked] = ' ';
          index = consumedEnd - 1;
          continue;
        }
      }
    } else {
      const destination = definitions.get(normalizeLabel(label));
      if (destination) {
        destinations.push(destination);
        const consumedEnd = close + 1;
        for (let masked = index; masked < consumedEnd; masked += 1) autolinkSource[masked] = ' ';
        index = consumedEnd - 1;
        continue;
      }
    }
    index = close;
  }
  return { destinations, autolinkSource: autolinkSource.join('') };
}

function analyzeMarkdown(text: string): MarkdownAnalysis {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  maskFrontMatter(lines);
  maskFences(lines);
  maskInlineCode(lines);

  const headings: Heading[] = [];
  for (const line of lines) {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (text) headings.push({ level: match[1]!.length, text });
  }

  const { definitions, definitionLines } = referenceDefinitions(lines);
  const destinations: string[] = [];
  lines.forEach((line, index) => {
    if (definitionLines.has(index)) return;
    const inline = inlineDestinations(line, definitions);
    destinations.push(...inline.destinations);
    for (const match of inline.autolinkSource.matchAll(/<(https?:\/\/[^<>\s]+)>/gi)) {
      if (!isEscaped(inline.autolinkSource, match.index)) destinations.push(match[1]!);
    }
  });
  return { headings, destinations };
}

function evidence(discovery: Discovery, path: string, extract: string, symbol?: string): Evidence {
  const file = discovery.files.find((candidate) => candidate.path === path);
  if (!file) throw new ScanInputError(`Markdown evidence path is absent from discovery: ${path}`);
  return {
    repository: 'local',
    commit: discovery.dirty ? 'working-tree' : (discovery.base_commit ?? 'working-tree'),
    path,
    ...(symbol ? { symbol } : {}),
    analyzer: ANALYZER,
    analyzer_version: MARKDOWN_ADAPTER_VERSION,
    blob_hash: file.blob_hash,
    extract_hash: hashContent(Buffer.from(extract)),
  };
}

function repoRelativePath(from: string, destination: string): string | null {
  if (destination.startsWith('/') || destination.includes('\\')) return null;
  const segments = dirname(from) === '.' ? [] : dirname(from).split('/');
  for (const segment of destination.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join('/') : null;
}

function conventionClaims(discovery: Discovery, path: string): Claim[] {
  const parts = path.split('/');
  const basename = parts.at(-1)!;
  const directories = parts.slice(0, -1).map((part) => part.toLowerCase());
  const adrFilename = /^adr[-_]\d+.*\.(?:md|markdown)$/i.test(basename);
  const decisionsDirectory = directories.some((part) => ['adr', 'adrs', 'decision', 'decisions'].includes(part));
  const ledgerDirectory = directories.some((part) => part === 'ledger' || part === 'ledgers');
  const claims: Claim[] = [];

  if (adrFilename || decisionsDirectory) {
    const convention = adrFilename && decisionsDirectory
      ? 'ADR filename in decisions directory'
      : adrFilename ? 'ADR filename' : 'decisions directory';
    claims.push({
      id: `claim_${shortHash(`${path}|markdown-decision|${convention}`)}`,
      type: 'fact',
      text: `Decision record (path convention: ${convention}).`,
      status: 'active',
      confidence: 1,
      provenance: PROVENANCE,
      evidence: [evidence(discovery, path, `decision path convention: ${convention}`)],
    });
  }
  if (ledgerDirectory) {
    const convention = 'ledger directory';
    claims.push({
      id: `claim_${shortHash(`${path}|markdown-ledger|${convention}`)}`,
      type: 'fact',
      text: `Ledger asset (path convention: ${convention}).`,
      status: 'active',
      confidence: 1,
      provenance: PROVENANCE,
      evidence: [evidence(discovery, path, `ledger path convention: ${convention}`)],
    });
  }
  return claims.sort((left, right) => left.id.localeCompare(right.id));
}

interface ResolutionContext {
  discovery: Discovery;
  fileSet: ReadonlySet<string>;
  perFileNodeIds: ReadonlyMap<string, string>;
  externalNodes: Map<string, Node>;
}

function ensureExternal(ctx: ResolutionContext, destination: string): string {
  const id = externalNodeId(destination);
  if (!ctx.externalNodes.has(id)) {
    const title = /^(?:https?:|mailto:)/i.test(destination) ? destination : `unresolved:${destination}`;
    ctx.externalNodes.set(id, { id, slug: slugFor(title), kind: 'external', title, claims: [], relations: [] });
  }
  return id;
}

function perFileTarget(ctx: ResolutionContext, path: string): string {
  if (isMarkdown(path)) return docNodeId(path);
  return ctx.perFileNodeIds.get(path) ?? containingNodeId(path);
}

function linkRelation(ctx: ResolutionContext, path: string, destination: string): Relation | null {
  if (destination.startsWith('#')) return null;
  const partial = (): Relation => ({
    id: `rel_${shortHash(`${path}|markdown-link|${destination}`)}`,
    type: 'depends-on',
    target: ensureExternal(ctx, destination),
    certainty: 'partial',
    provenance: PROVENANCE,
    evidence: [evidence(ctx.discovery, path, `markdown link ${destination}`, destination)],
  });
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//') || destination.includes('\\')) {
    return partial();
  }
  const fragment = destination.indexOf('#');
  const fileDestination = fragment === -1 ? destination : destination.slice(0, fragment);
  if (!fileDestination) return null;
  const targetPath = repoRelativePath(path, fileDestination);
  if (!targetPath || !ctx.fileSet.has(targetPath)) return partial();
  return {
    id: `rel_${shortHash(`${path}|markdown-link|${destination}`)}`,
    type: 'depends-on',
    target: perFileTarget(ctx, targetPath),
    certainty: 'known',
    provenance: PROVENANCE,
    evidence: [evidence(ctx.discovery, path, `markdown link ${destination}`, destination)],
  };
}

/** Build one schema-v1 store node per retained Markdown file plus unresolved/external targets. */
export function analyzeMarkdownDocuments(discovery: Discovery, availableNodes: Node[]): MarkdownModelResult {
  const fileSet = new Set(discovery.files.map((file) => file.path));
  const perFileNodeIds = new Map(
    availableNodes.flatMap((node) =>
      node.scope?.files?.length === 1 && node.scope.files[0] === node.title &&
        (node.kind === 'module' || node.kind === 'store')
        ? [[node.scope.files[0], node.id] as const]
        : [],
    ),
  );
  const ctx: ResolutionContext = {
    discovery,
    fileSet,
    perFileNodeIds,
    externalNodes: new Map(),
  };
  const documents: Node[] = [];

  for (const path of [...discovery.contents.keys()].filter(isMarkdown).sort()) {
    const analysis = analyzeMarkdown(discovery.contents.get(path)!.toString('utf8'));
    const titleIndex = analysis.headings.findIndex((heading) => heading.level === 1);
    const title = titleIndex === -1 ? path : analysis.headings[titleIndex]!.text;
    const symbols = [...new Set(analysis.headings.filter((_, index) => index !== titleIndex).map((heading) => heading.text))].sort();
    const relations = new Map<string, Relation>();
    for (const destination of analysis.destinations) {
      const relation = linkRelation(ctx, path, destination);
      if (relation) relations.set(relation.id, relation);
    }
    documents.push({
      id: docNodeId(path),
      slug: slugFor(path),
      kind: 'store',
      title,
      scope: symbols.length > 0 ? { files: [path], symbols } : { files: [path] },
      claims: conventionClaims(discovery, path),
      relations: [...relations.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  return {
    capability: MARKDOWN_CAPABILITY,
    nodes: [...documents, ...ctx.externalNodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
