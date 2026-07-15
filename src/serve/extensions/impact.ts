/** V5's independently owned server registration slot. */

import { createImpactFeature } from '../impact.js';
import type { ViewerExtensionContext, ViewerExtensionRegistry } from '../features.js';

/**
 * V3 intentionally leaves the impact slot empty. V5 adds its read-only impact adapter here
 * without editing the server composition or another lane's registration module.
 */
export function registerImpactExtension(
  registry: ViewerExtensionRegistry,
  context: ViewerExtensionContext,
): void {
  registry.register('impact', createImpactFeature(context.cwd));
}
