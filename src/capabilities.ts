/**
 * Adapter capability registry.
 *
 * M1 ships only the universal adapter. Language/domain adapters are declared here as
 * `unsupported` so `archmap capabilities` reports them explicitly rather than silently
 * omitting them — graceful degradation must never disguise a gap (PLAN 3.5).
 */

import type { Capability } from './model/types.js';

/** Version of the universal adapter; part of every universal fact's re-verification identity. */
export const UNIVERSAL_ADAPTER_VERSION = '0.1.0';

/** The universal adapter capability, declared in every scanned manifest. */
export const UNIVERSAL_CAPABILITY: Capability = {
  id: 'universal',
  version: UNIVERSAL_ADAPTER_VERSION,
  status: 'supported',
  provides: ['files', 'directories', 'git', 'manifest-detection', 'doc-detection', 'config-detection'],
};

/** The full adapter registry as of this build, for `archmap capabilities`. */
export const ADAPTER_REGISTRY: readonly Capability[] = [
  UNIVERSAL_CAPABILITY,
  { id: 'typescript', version: '0.0.0', status: 'unsupported', provides: ['symbols', 'imports'] },
  { id: 'python', version: '0.0.0', status: 'unsupported', provides: ['modules', 'imports'] },
];
