/** V6's independently owned server registration slot. */

import { createDiffFeature } from '../diff.js';
import type { ViewerExtensionContext, ViewerExtensionRegistry } from '../features.js';

/**
 * The diff adapter owns this pre-assigned slot without editing server composition or another
 * lane's registration module.
 */
export function registerDiffExtension(
  registry: ViewerExtensionRegistry,
  context: ViewerExtensionContext,
): void {
  registry.register('diff', createDiffFeature(context.cwd));
}
