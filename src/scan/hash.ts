/** Content hashing for evidence and snapshots. */

import { createHash } from 'node:crypto';

/** sha256 of raw bytes, formatted as `sha256:<hex>` to match the evidence hash convention. */
export function hashContent(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
