import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Python public capability surfaces', () => {
  it('agree on unsupported identity when the configured runtime is missing', () => {
    const script = [
      "import { ADAPTER_REGISTRY, PYTHON_CAPABILITY, getAdapterRegistry } from './src/index.ts';",
      "const pick = (xs) => xs.find((capability) => capability.id === 'python');",
      'process.stdout.write(JSON.stringify({ direct: PYTHON_CAPABILITY, registry: pick(ADAPTER_REGISTRY), fresh: pick(getAdapterRegistry()) }));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ARCHMAP_PYTHON: '/definitely/missing/python' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.direct).toEqual(report.registry);
    expect(report.direct).toEqual(report.fresh);
    expect(report.direct).toEqual(
      expect.objectContaining({ id: 'python', version: '0.1.0', status: 'unsupported' }),
    );
  });
});
