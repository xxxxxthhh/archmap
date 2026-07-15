/** V6's independently owned server registration slot. */

import type { ViewerExtensionContext, ViewerExtensionRegistry } from '../features.js';

/**
 * V3 intentionally leaves the diff slot empty. V6 adds its read-only diff feature here without
 * editing the server composition or another lane's registration module.
 */
export function registerDiffExtension(
  _registry: ViewerExtensionRegistry,
  _context: ViewerExtensionContext,
): void {}
