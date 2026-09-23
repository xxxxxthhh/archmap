// Types for scripts/flagship-demo.mjs, used by test/flagship-demo.test.ts.

export const SAMPLE_NAME: string;
export const SAMPLE_DIR: string;
export const SITE_DATA_PATH: string;
export const TEMP_PREFIX: string;

export interface DemoStep {
  id: string;
  title: string;
  command: string;
  exit_code: number | null;
  note: string;
  // Parsed JSON output of the recorded command.
  output: any;
}

export interface WalkthroughResult {
  sampleCommit: string;
  editCommit: string;
  sourceBefore: { path: string; text: string }[];
  steps: DemoStep[];
  graphBefore: unknown[];
  graphAfter: unknown[];
}

export function createDisposableCopy(): { owned: string; root: string };
export function removeOwnedCopy(owned: string): void;
export function runWalkthrough(
  root: string,
  options?: { cli?: string[]; log?: (step: DemoStep) => void },
): WalkthroughResult;
export function sanitize<T>(value: T, root: string): T;
export function buildRecord(result: WalkthroughResult, root: string): unknown;
export function renderSiteData(record: unknown): string;
