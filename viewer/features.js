// Fixed client extension host for M5. This is deliberately a small static registry, not a
// discovery-based plugin system: V4, V5, and V6 each own exactly one module and one DOM slot.

import { mountDiffFeature } from './extensions/diff.js';
import { mountEvidenceFeature } from './extensions/evidence.js';
import { mountFiltersFeature } from './extensions/filters.js';

const FEATURE_MOUNTS = [
  { slot: 'evidence', mount: mountEvidenceFeature },
  { slot: 'filters', mount: mountFiltersFeature },
  { slot: 'diff', mount: mountDiffFeature },
];

/**
 * Mount every fixed M5 feature after the graph has rendered. Each module receives the immutable
 * graph payload, the rendered map, and only its own dedicated DOM slot; later slices never need
 * to edit `app.js` or another slice's client module to attach their UI.
 */
export async function mountViewerFeatures(context) {
  for (const feature of FEATURE_MOUNTS) {
    const slot = context.slots[feature.slot];
    if (!slot) throw new Error(`missing viewer feature slot "${feature.slot}"`);
    await feature.mount({ ...context, slot });
    // A deterministic, inert boot marker lets browser coverage prove the module seam executed.
    slot.setAttribute('data-feature-mounted', 'true');
  }
}
