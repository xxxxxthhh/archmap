/**
 * Fixed extension seams for the loopback viewer (Issue #30).
 *
 * V3 owns the server composition once. Later M5 slices do not edit `server.ts`: each uses the
 * one pre-assigned module below to register its own read-only route feature. The slots are
 * deliberately fixed and small rather than a discovery-based plugin system:
 *
 * - `evidence` is owned by V4;
 * - `impact` is owned by V5;
 * - `diff` is owned by V6.
 *
 * Every extension remains subject to the router's GET-only and content-safety boundary. The
 * registry also refuses fallback handlers, so the V3 asset feature remains the sole owner of the
 * static-file catch-all.
 */

import { createGraphFeature } from './api.js';
import { createAssetsFeature } from './assets.js';
import { registerDiffExtension } from './extensions/diff.js';
import { registerEvidenceExtension } from './extensions/evidence.js';
import { registerImpactExtension } from './extensions/impact.js';
import type { FeatureModule } from './router.js';

/** The intentionally finite set of M5 extension slots. */
export const VIEWER_EXTENSION_SLOTS = ['evidence', 'impact', 'diff'] as const;
export type ViewerExtensionSlot = (typeof VIEWER_EXTENSION_SLOTS)[number];

/** Context that future extension modules receive without reaching into the server root. */
export interface ViewerExtensionContext {
  cwd: string;
}

/**
 * Collects independently owned route features. One module owns each slot, preventing accidental
 * cross-lane registration while preserving a deterministic feature order.
 */
export class ViewerExtensionRegistry {
  readonly #features = new Map<ViewerExtensionSlot, FeatureModule>();

  register(slot: ViewerExtensionSlot, feature: FeatureModule): void {
    if (feature.fallback) {
      throw new Error(`viewer extension slot "${slot}" cannot register the static-asset fallback`);
    }
    if (this.#features.has(slot)) {
      throw new Error(`viewer extension slot "${slot}" is already registered`);
    }
    this.#features.set(slot, feature);
  }

  /** Return extension modules in their fixed M5 order, omitting slots that have no routes yet. */
  modules(): FeatureModule[] {
    return VIEWER_EXTENSION_SLOTS.flatMap((slot) => {
      const feature = this.#features.get(slot);
      return feature ? [feature] : [];
    });
  }
}

/**
 * Compose V3's base features with the fixed future-M5 registration slots. This is the only place
 * that knows the composition order; later slices edit their assigned extension module, never
 * `server.ts` or this registry.
 */
export function createViewerFeatures(cwd: string): FeatureModule[] {
  const registry = new ViewerExtensionRegistry();
  const context: ViewerExtensionContext = { cwd };

  registerEvidenceExtension(registry, context);
  registerImpactExtension(registry, context);
  registerDiffExtension(registry, context);

  return [createGraphFeature(cwd), ...registry.modules(), createAssetsFeature()];
}
