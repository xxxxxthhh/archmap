/** Which files a language adapter can analyze. Kept tiny and shared so discovery knows which
 * file contents to retain for the analysis phase. */

/** Extensions the TypeScript/JavaScript adapter parses. */
export const TS_JS_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

/** True when `path` is a TypeScript/JavaScript source file (by extension). */
export function isTsJs(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return false;
  const slash = path.lastIndexOf('/');
  if (dot < slash) return false; // dot is in a directory segment, not the basename
  return TS_JS_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}
