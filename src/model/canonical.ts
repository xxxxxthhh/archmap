/**
 * Canonical serialization.
 *
 * A manifest's canonical form is deterministic: object keys are sorted lexicographically,
 * arrays keep their authored order (order is semantically meaningful), and the output ends
 * with a single trailing newline. Two runs over equal input produce byte-identical output,
 * which is what the round-trip stability guarantee (PLAN 12, M0 exit criteria) rests on.
 *
 * Tracked manifests are authored as YAML; `toCanonicalYaml` gives the same determinism for
 * scanner-written YAML so repeated no-change scans produce no tracked diff (M1 exit criteria).
 */

import { stringify as stringifyYaml } from 'yaml';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Compare strings by UTF-16 code units, independent of host locale/ICU configuration. */
export function compareCodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    // Null-prototype target so a `__proto__` key is stored as an own property (and survives
    // serialization) instead of mutating the prototype or being dropped.
    const out: { [key: string]: Json } = Object.create(null);
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      out[key] = sortKeys((value as { [key: string]: Json })[key] as Json);
    }
    return out;
  }
  return value;
}

/** Serialize any JSON-compatible value to canonical JSON text (sorted keys, trailing newline). */
export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as Json), null, 2) + '\n';
}

/**
 * Serialize to canonical YAML: map keys sorted, no line wrapping. Deterministic for a given
 * value, so re-writing unchanged scan output yields byte-identical files.
 */
export function toCanonicalYaml(value: unknown): string {
  return stringifyYaml(value, { sortMapEntries: true, lineWidth: 0 });
}
