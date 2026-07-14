/** Deterministic exact/substring search over the validated tracked node model. */

import type { Node } from '../model/types.js';

export type SearchField = 'slug' | 'title' | 'scope.files' | 'claims.text';

export interface SearchMatch {
  match: 'exact' | 'substring';
  matched_fields: SearchField[];
  node: Node;
}

export interface SearchResult {
  query: string;
  found: boolean;
  matches: SearchMatch[];
}

const normalize = (value: string): string => value.toLowerCase();

/**
 * Search slug, title, scoped paths, and claim text without fuzzy matching or scoring.
 * Results are ordered only by stable node id, independent of authored node order.
 */
export function searchArchitecture(nodes: Node[], query: string): SearchResult {
  const needle = normalize(query.trim());
  if (needle.length === 0) return { query, found: false, matches: [] };

  const matches: SearchMatch[] = [];
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const values: Array<[SearchField, string[]]> = [
      ['slug', [node.slug]],
      ['title', [node.title]],
      ['scope.files', node.scope?.files ?? []],
      ['claims.text', node.claims.map((claim) => claim.text)],
    ];
    const matchedFields: SearchField[] = [];
    let exact = false;
    for (const [field, candidates] of values) {
      const normalized = candidates.map(normalize);
      if (normalized.some((value) => value.includes(needle))) matchedFields.push(field);
      if (normalized.some((value) => value === needle)) exact = true;
    }
    if (matchedFields.length > 0) {
      matches.push({ match: exact ? 'exact' : 'substring', matched_fields: matchedFields, node });
    }
  }

  return { query, found: matches.length > 0, matches };
}
