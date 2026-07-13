/**
 * Structural node synthesis for the universal scanner.
 *
 * M1 produces a repository `system` node plus one `module` node per directory that directly
 * contains included files. Nodes scope their files but carry no claims: file-level facts
 * live in the snapshot, and richer per-file claims arrive with language adapters (M2+). This
 * keeps scan output free of any per-claim timestamp, so repeated no-change scans are stable.
 */

import { createHash } from 'node:crypto';
import type { Node } from '../model/types.js';
import type { FileRecord } from './types.js';

/** Stable internal id derived from the directory path (PLAN 6.3: id stable, slug renameable). */
export function nodeId(dirKey: string): string {
  return `node_${createHash('sha256').update(dirKey).digest('hex').slice(0, 16)}`;
}

/** Directory portion of a relative path, `.` for a root-level file. */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

/** Id of the structural node that would contain `path`. */
export function containingNodeId(path: string): string {
  return nodeId(dirOf(path));
}

/** Id of the repository root (`system`) node. */
export function rootNodeId(): string {
  return nodeId('.');
}

/** Human-readable slug matching the schema slug pattern; falls back to `repository` for root. */
export function slugFor(dirKey: string): string {
  if (dirKey === '.') return 'repository';
  const slug = dirKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'root';
}

/**
 * Build the structural node set from discovered files. `projectName` titles the root node.
 * Output is deterministic: directories are processed in sorted order and each node's
 * `scope.files` is sorted.
 */
export function buildNodes(files: FileRecord[], projectName: string): Node[] {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file.path);
    else byDir.set(dir, [file.path]);
  }

  // The root system node always exists, even when every file sits in a subdirectory.
  const nodes: Node[] = [
    {
      id: nodeId('.'),
      slug: 'repository',
      kind: 'system',
      title: projectName,
      ...(byDir.has('.') ? { scope: { files: byDir.get('.')!.slice().sort() } } : {}),
      claims: [],
      relations: [],
    },
  ];

  for (const dir of [...byDir.keys()].filter((d) => d !== '.').sort()) {
    nodes.push({
      id: nodeId(dir),
      slug: slugFor(dir),
      kind: 'module',
      title: dir,
      scope: { files: byDir.get(dir)!.slice().sort() },
      claims: [],
      relations: [],
    });
  }

  return nodes;
}
