/**
 * View definition contract for the M5 display-graph projection.
 *
 * A view is a saved *query and layout preference* over the validated model (PLAN 9). It never
 * stores source content, evidence, or AI-authored diagram text — those are re-derived from the
 * tracked model at export time. These TypeScript types mirror the tracked JSON Schema in
 * `schema/view.schema.json`, which is the authoritative structural contract; keep both in sync.
 */

import type { NodeKind, RelationType } from '../model/types.js';

/** Schema version this build of archmap understands for view files. */
export const VIEW_SCHEMA_VERSION = 1;

/** Node kinds that form the structural containment hierarchy, ordered outermost-first. */
export type StructuralKind = 'system' | 'component' | 'module';

/** How the deterministic layout arranges layers. */
export type ViewLayout = 'left-to-right' | 'top-to-bottom';

/** The allowlisted query filters a view may express. */
export interface ViewInclude {
  node_kinds?: NodeKind[];
  edge_types?: RelationType[];
  /** Repository-relative prefixes matched byte-for-byte against tracked `scope.files` paths. */
  path_prefixes?: string[];
}

/** A validated view definition. */
export interface ViewDefinition {
  schema_version: typeof VIEW_SCHEMA_VERSION;
  id: string;
  include?: ViewInclude;
  /** Collapse (hide) structural nodes deeper than this granularity. */
  collapse_below?: StructuralKind;
  layout?: ViewLayout;
}

/**
 * The built-in view used when `export` is invoked without `--view`: every node kind and edge
 * type, no collapse, left-to-right. It exists so export works on a freshly scanned project that
 * has no tracked view files yet.
 */
export const DEFAULT_VIEW: ViewDefinition = {
  schema_version: VIEW_SCHEMA_VERSION,
  id: 'default',
  layout: 'left-to-right',
};

/** Effective (defaulted) filters for a view: every kind/type is allowed when a filter is absent. */
export interface EffectiveFilters {
  nodeKinds: Set<NodeKind>;
  edgeTypes: Set<RelationType>;
  pathPrefixes?: readonly string[];
  collapseBelow?: StructuralKind;
  layout: ViewLayout;
}

const ALL_NODE_KINDS: readonly NodeKind[] = ['system', 'component', 'module', 'external', 'store'];
const ALL_EDGE_TYPES: readonly RelationType[] = [
  'calls',
  'reads',
  'writes',
  'imports',
  'publishes',
  'consumes',
  'depends-on',
];

/** Resolve a view's optional filters into concrete allow-sets (absent filter = allow all). */
export function effectiveFilters(view: ViewDefinition): EffectiveFilters {
  return {
    nodeKinds: new Set(view.include?.node_kinds ?? ALL_NODE_KINDS),
    edgeTypes: new Set(view.include?.edge_types ?? ALL_EDGE_TYPES),
    ...(view.include?.path_prefixes !== undefined
      ? { pathPrefixes: view.include.path_prefixes }
      : {}),
    ...(view.collapse_below ? { collapseBelow: view.collapse_below } : {}),
    layout: view.layout ?? 'left-to-right',
  };
}
