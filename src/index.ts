/** Public library surface for archmap's M0 schema contract. */

export * from './model/types.js';
export { toCanonicalJson } from './model/canonical.js';
export { validateManifest } from './validate/validate.js';
export type { ValidationError, ValidationResult } from './validate/validate.js';
export { loadManifestFile, ManifestLoadError } from './validate/load.js';
