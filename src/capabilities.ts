/**
 * Adapter capability registry.
 *
 * Adapters declare their capability and status here so `archmap capabilities` reports them
 * explicitly — graceful degradation must never disguise a gap (PLAN 3.5). A capability's
 * `status: supported` means its declared `provides` are deterministic; heuristic detections
 * (e.g. routes, HTTP calls) are represented as `partial` relations, never promoted to facts.
 */

import type { Capability } from './model/types.js';

/** Version of the universal adapter; part of every universal fact's re-verification identity. */
export const UNIVERSAL_ADAPTER_VERSION = '0.1.0';

/** Version of the TypeScript/JavaScript adapter. */
export const TYPESCRIPT_ADAPTER_VERSION = '0.1.0';

/** The universal adapter capability, declared in every scanned manifest. */
export const UNIVERSAL_CAPABILITY: Capability = {
  id: 'universal',
  version: UNIVERSAL_ADAPTER_VERSION,
  status: 'supported',
  provides: ['files', 'directories', 'git', 'manifest-detection', 'doc-detection', 'config-detection'],
};

/**
 * The TypeScript/JavaScript adapter capability. Its supported (deterministic, syntactic)
 * outputs are modules, imports/exports, and entry points; route/CLI/HTTP detections are
 * heuristic and surface as `partial` relations rather than deterministic facts.
 */
export const TYPESCRIPT_CAPABILITY: Capability = {
  id: 'typescript',
  version: TYPESCRIPT_ADAPTER_VERSION,
  status: 'supported',
  provides: ['modules', 'imports', 'exports', 'entry-points'],
};

/** The full adapter registry as of this build, for `archmap capabilities`. */
export const ADAPTER_REGISTRY: readonly Capability[] = [
  UNIVERSAL_CAPABILITY,
  TYPESCRIPT_CAPABILITY,
  { id: 'python', version: '0.0.0', status: 'unsupported', provides: ['modules', 'imports'] },
];
