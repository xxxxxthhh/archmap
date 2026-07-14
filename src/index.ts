/** Public library surface for archmap. */

// M0: schema contract
export * from './model/types.js';
export { toCanonicalJson, toCanonicalYaml } from './model/canonical.js';
export { validateManifest } from './validate/validate.js';
export type { ValidationError, ValidationResult } from './validate/validate.js';
export { loadManifestFile, ManifestLoadError } from './validate/load.js';

// M1: universal scanner
export * from './scan/types.js';
export { discover } from './scan/discover.js';
export { classify } from './scan/classify.js';
export { buildSnapshot, diffSnapshot } from './scan/snapshot.js';
export { buildNodes } from './scan/nodes.js';
export { runScan } from './scan/scanner.js';
export { StoreError, StoreFormatError, StorePathError, ScanInputError } from './store-errors.js';
export type { ScanResult } from './scan/scanner.js';
export { computeStatus } from './scan/status.js';
export type { StatusResult } from './scan/status.js';
export { ADAPTER_REGISTRY, getAdapterRegistry, UNIVERSAL_CAPABILITY } from './capabilities.js';
export * as store from './store.js';

// M2: TypeScript/JavaScript adapter + queries
export { TYPESCRIPT_CAPABILITY } from './capabilities.js';
export { analyzeSource } from './analyze/typescript.js';
export type { ModuleAnalysis } from './analyze/typescript.js';
export { analyzeModules } from './analyze/model.js';
export { isTsJs } from './analyze/languages.js';
export { contextFor, impactFor, evidenceFor, DEFAULT_CONTEXT_BUDGET } from './query/queries.js';
export type { ContextResult, ImpactResult, EvidenceResult } from './query/queries.js';

// M4: deterministic read-only work items and search
export { searchArchitecture } from './query/search.js';
export type { SearchField, SearchMatch, SearchResult } from './query/search.js';
export { workItemsFor, DEFAULT_WORK_ITEM_EVIDENCE_BUDGET } from './query/work-items.js';
export type {
  WorkItem,
  WorkItemEvidenceBundle,
  WorkItemReason,
  WorkItemsResult,
} from './query/work-items.js';

// M4: external proposal contract, validation, and read-only preview
export * from './proposal/index.js';

// M3: Python adapter
export { PYTHON_CAPABILITY } from './capabilities.js';
export { analyzePythonModules } from './analyze/python-model.js';
export { isPython } from './analyze/languages.js';

// M3: Markdown docs and knowledge assets
export { MARKDOWN_CAPABILITY } from './capabilities.js';
export { analyzeMarkdownDocuments } from './analyze/markdown.js';
export { isMarkdown } from './analyze/languages.js';

// M3: YAML/JSON data/config assets and Python data-flow targets
export { DATA_CAPABILITY } from './capabilities.js';
export { analyzeDataAssets } from './analyze/data.js';
export { isYamlJson } from './analyze/languages.js';
