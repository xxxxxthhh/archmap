/** V4's independently owned server registration slot. */

import { registerEvidenceApi } from '../evidence-api.js';
import type { ViewerExtensionContext, ViewerExtensionRegistry } from '../features.js';

/**
 * V4 adds its single bounded, read-only evidence route here without editing the server
 * composition or another lane's registration module.
 */
export function registerEvidenceExtension(
  registry: ViewerExtensionRegistry,
  context: ViewerExtensionContext,
): void {
  registerEvidenceApi(registry, context);
}
