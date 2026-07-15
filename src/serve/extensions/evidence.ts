/** V4's independently owned server registration slot. */

import type { ViewerExtensionContext, ViewerExtensionRegistry } from '../features.js';

/**
 * V3 intentionally leaves the evidence slot empty. V4 adds its read-only evidence feature here
 * without editing the server composition or another lane's registration module.
 */
export function registerEvidenceExtension(
  _registry: ViewerExtensionRegistry,
  _context: ViewerExtensionContext,
): void {}
