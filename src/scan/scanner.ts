/**
 * Scan orchestration: read + validate the tracked baseline → discover → compute the
 * prospective model (structure + preserved enrichment) → validate against the M0 contract →
 * persist. Nothing is written (not even the disposable cache) until every check passes, so an
 * invalid tracked baseline or a scan that would drop human enrichment fails closed, leaving
 * the snapshot, nodes, and cache untouched.
 */

import type { Manifest } from '../model/types.js';
import { validateManifest, type ValidationError } from '../validate/validate.js';
import { buildIndex, publishModel, readProject, writeIndex } from '../store.js';
import { readTrackedBaseline, type TrackedBaseline } from './baseline.js';
import { discover } from './discover.js';
import { assertNoEnrichmentLoss, modelDrift, prospectiveModel } from './projection.js';
import { diffSnapshot } from './snapshot.js';
import type { Snapshot } from './types.js';

export interface ScanResult {
  wrote: boolean;
  /** False when `--changed` found nothing to do. */
  changed: boolean;
  snapshot: Snapshot;
  nodeCount: number;
  /** Present only when the generated model failed the contract self-check. */
  validationErrors?: ValidationError[];
}

/** Run a scan under `root`. Requires the project to be initialized. */
export function runScan(root: string, options: { changed?: boolean } = {}): ScanResult {
  const project = readProject(root);
  // Fully validate the existing tracked model before touching anything; an illegal baseline
  // (bad node semantics, duplicate ids, snapshot↔node inconsistency) fails closed here.
  const baseline = readTrackedBaseline(root);
  const tracked = baseline?.nodes ?? [];

  const discovery = discover(root, project.scan);
  const model = prospectiveModel(discovery, project.project.name, tracked);

  // Refuse to proceed if the scan would delete human enrichment on a vanished node.
  assertNoEnrichmentLoss(tracked, model.nodes);

  const manifest: Manifest = {
    schema_version: 1,
    capabilities: model.snapshot.capabilities,
    nodes: model.nodes,
  };
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return {
      wrote: false,
      changed: true,
      snapshot: model.snapshot,
      nodeCount: model.nodes.length,
      validationErrors: validation.errors,
    };
  }

  // `--changed` skips writing tracked files only when the prospective model matches the
  // tracked one — the same shared projection/comparison `status` uses for `clean`. The
  // disposable cache is still refreshed (model == tracked here) so a stale cache is repaired.
  if (options.changed && baseline && isCurrent(baseline, model)) {
    writeIndex(root, buildIndex(model.nodes));
    return { wrote: false, changed: false, snapshot: model.snapshot, nodeCount: model.nodes.length };
  }

  // Publish snapshot + nodes atomically (rollback on failure), then refresh the derived cache
  // only after the tracked model is successfully committed.
  publishModel(root, model.snapshot, model.nodes);
  writeIndex(root, buildIndex(model.nodes));

  return { wrote: true, changed: true, snapshot: model.snapshot, nodeCount: model.nodes.length };
}

function isCurrent(baseline: TrackedBaseline, model: ReturnType<typeof prospectiveModel>): boolean {
  const diff = diffSnapshot(baseline.snapshot.files, model.snapshot.files);
  const filesChanged =
    diff.added.length > 0 ||
    diff.modified.length > 0 ||
    diff.deleted.length > 0 ||
    diff.renamed.length > 0;
  return !filesChanged && modelDrift(model, baseline.snapshot, baseline.nodes).length === 0;
}
