/**
 * `archmap export --format mermaid|markdown|svg [--view <id>] [--json]`
 *
 * Projects the validated tracked model through a view and renders it as a deterministic static
 * export. Output goes to stdout only — export never writes to the repository, so it can never
 * mutate the tracked model or leave a partial artifact. `--json` wraps the projection and the
 * rendered text in a schema-versioned canonical JSON envelope; without it, the raw rendered
 * artifact is emitted.
 *
 * Fail-closed paths (all exit 2, nothing on stdout): an unscanned/absent project, a missing
 * format, an invalid or malicious view, or a projection that exceeds the deterministic layout's
 * readability probe.
 */

import { toCanonicalJson } from '../model/canonical.js';
import { loadTrackedProject } from '../query/project.js';
import { EXPORT_FORMATS, isExportFormat, projectModel, readabilityProbe, renderGraph } from '../render/index.js';
import { defaultView, loadView } from '../views/load.js';
import { parseOptions, takeOptionValue, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runExportCommand(args: string[], ctx: CommandContext): CommandOutput {
  const format = takeOptionValue(args, '--format');
  if (format.error) return usageError(args.includes('--json'), format.error);
  const view = takeOptionValue(format.rest, '--view');
  if (view.error) return usageError(args.includes('--json'), view.error);

  const opts = parseOptions(view.rest, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length > 0) {
    return usageError(json, 'export takes no positional arguments');
  }
  if (format.value === undefined) {
    return usageError(json, `export requires --format <${EXPORT_FORMATS.join('|')}>`);
  }
  if (!isExportFormat(format.value)) {
    return usageError(json, `unknown export format "${format.value}"; expected ${EXPORT_FORMATS.join('|')}`);
  }

  const loaded = loadTrackedProject(ctx.cwd);
  if (!loaded.ok) return usageError(json, loaded.error);

  const viewResult = view.value === undefined ? defaultView() : loadView(loaded.root, view.value);
  if (!viewResult.ok) return usageError(json, `view: ${viewResult.error}`);

  const graph = projectModel(loaded.baseline.nodes, viewResult.view);

  const probe = readabilityProbe(graph);
  if (!probe.ok) return usageError(json, `readability probe failed: ${probe.reason}`);

  const rendered = renderGraph(format.value, graph);

  if (json) {
    const envelope = {
      schema_version: 1,
      command: 'export',
      format: format.value,
      view: graph.view,
      projection: { nodes: graph.nodes, edges: graph.edges, stats: graph.stats },
      output: rendered,
    };
    return { exitCode: 0, stdout: toCanonicalJson(envelope), stderr: '' };
  }

  return { exitCode: 0, stdout: rendered, stderr: '' };
}
