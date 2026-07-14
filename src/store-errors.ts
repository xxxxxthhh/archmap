/** Errors raised by the storage layer. Commands map any `StoreError` to a stable exit code. */

/** Base class for all storage-layer failures. */
export class StoreError extends Error {}

/** A persisted file is malformed or an unsupported version. */
export class StoreFormatError extends StoreError {}

/** A store path is (or passes through) a symlink, risking a read/write outside the repository. */
export class StorePathError extends StoreError {}

/**
 * A source file or directory could not be read during discovery for a reason other than it
 * being absent (e.g. EACCES/EIO). Such a read must never be mistaken for a deletion, so it
 * fails the scan closed rather than silently shrinking the model.
 */
export class ScanInputError extends StoreError {}
