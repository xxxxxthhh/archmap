/** Optional desk extensions, loaded by a module name that is only known at runtime. */

export interface DeskPlugin {
  name: string;
  start(): void;
}

export async function loadPlugins(names: string[]): Promise<DeskPlugin[]> {
  const plugins: DeskPlugin[] = [];
  for (const name of names) {
    const mod = (await import(`./${name}.js`)) as { default: DeskPlugin };
    plugins.push(mod.default);
  }
  return plugins;
}
