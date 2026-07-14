/** Which files a language adapter can analyze. Kept tiny and shared so discovery knows which
 * file contents to retain for the analysis phase. */

/** Extensions the TypeScript/JavaScript adapter parses. */
export const TS_JS_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

/** Extension parsed by the Python adapter. */
export const PYTHON_EXTENSIONS: readonly string[] = ['py'];

/** Extensions parsed by the bounded Markdown docs adapter (MDX is intentionally excluded). */
export const MARKDOWN_EXTENSIONS: readonly string[] = ['md', 'markdown'];

/** Extensions parsed by the bounded YAML/JSON data adapter. */
export const YAML_JSON_EXTENSIONS: readonly string[] = ['yaml', 'yml', 'json'];

/** True when `path` is a TypeScript/JavaScript source file (by extension). */
export function isTsJs(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return false;
  const slash = path.lastIndexOf('/');
  if (dot < slash) return false; // dot is in a directory segment, not the basename
  return TS_JS_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** True when `path` is a Python source file. */
export function isPython(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot < path.lastIndexOf('/')) return false;
  return PYTHON_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** True when `path` is a plain Markdown document supported by the docs adapter. */
export function isMarkdown(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot < path.lastIndexOf('/')) return false;
  return MARKDOWN_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** True when `path` has a YAML/JSON extension; classifier precedence is checked separately. */
export function isYamlJson(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot < path.lastIndexOf('/')) return false;
  return YAML_JSON_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}
