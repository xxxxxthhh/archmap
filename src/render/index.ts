/**
 * Render dispatch for the `export` command. Projection and readability probe live in their own
 * modules; this file only maps a format name to its renderer so callers share one entry point.
 */

import type { DisplayGraph } from './project.js';
import { renderMarkdown } from './markdown.js';
import { renderMermaid } from './mermaid.js';
import { renderSvg } from './svg.js';

export type ExportFormat = 'mermaid' | 'markdown' | 'svg';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['mermaid', 'markdown', 'svg'];

/** True when `value` is a supported export format. */
export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Render `graph` in `format`. */
export function renderGraph(format: ExportFormat, graph: DisplayGraph): string {
  switch (format) {
    case 'mermaid':
      return renderMermaid(graph);
    case 'markdown':
      return renderMarkdown(graph);
    case 'svg':
      return renderSvg(graph);
  }
}

export { projectModel } from './project.js';
export type { DisplayGraph } from './project.js';
export { readabilityProbe } from './probe.js';
