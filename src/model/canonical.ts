/**
 * Canonical serialization.
 *
 * A manifest's canonical form is deterministic: object keys are sorted lexicographically,
 * arrays keep their authored order (order is semantically meaningful), and the output ends
 * with a single trailing newline. Two runs over equal input produce byte-identical output,
 * which is what the round-trip stability guarantee (PLAN 12, M0 exit criteria) rests on.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key] as Json);
    }
    return out;
  }
  return value;
}

/** Serialize any JSON-compatible value to canonical JSON text (sorted keys, trailing newline). */
export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as Json), null, 2) + '\n';
}
