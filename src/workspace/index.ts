/** Build a deterministic workspace cache from validated persisted member baselines only. */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { compareCodeUnits, toCanonicalJson } from '../model/canonical.js';
import type { Node } from '../model/types.js';
import { readTrackedBaseline } from '../scan/baseline.js';
import { hashContent } from '../scan/hash.js';
import type { Snapshot } from '../scan/types.js';
import { readProject } from '../store.js';
import { StoreFormatError, StorePathError } from '../store-errors.js';
import type { WorkspaceIndex, WorkspaceMember } from './types.js';

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function memberParts(path: string): string[] {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new StoreFormatError(`workspace member path must be repository-relative: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new StoreFormatError(`workspace member path must not contain empty, . or .. segments: ${JSON.stringify(path)}`);
  }
  return parts;
}

/** Resolve a member beneath the owner while rejecting every symlinked path component. */
function memberRoot(ownerRoot: string, path: string): string {
  let current = ownerRoot;
  for (const part of memberParts(path)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (errno(error) === 'ENOENT') {
        throw new StoreFormatError(`workspace member does not exist: ${JSON.stringify(path)}`);
      }
      throw new StorePathError(
        `cannot access workspace member ${JSON.stringify(path)} (${errno(error) ?? 'error'})`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new StorePathError(`refusing to follow symlinked workspace member path: ${JSON.stringify(path)}`);
    }
    if (!stat.isDirectory()) {
      throw new StoreFormatError(`workspace member is not a directory: ${JSON.stringify(path)}`);
    }
  }
  return current;
}

function baselineIdentity(snapshot: Snapshot, nodes: Node[]): string {
  return hashContent(Buffer.from(toCanonicalJson({ snapshot, nodes }), 'utf8'));
}

function loadMember(ownerRoot: string, path: string): WorkspaceMember {
  const root = memberRoot(ownerRoot, path);
  const project = readProject(root);
  const baseline = readTrackedBaseline(root);
  if (!baseline) {
    throw new StoreFormatError(`workspace member is not scanned: ${JSON.stringify(path)}`);
  }
  return {
    path,
    project_id: project.project.id,
    project_name: project.project.name,
    snapshot_identity: baselineIdentity(baseline.snapshot, baseline.nodes),
    dirty: baseline.snapshot.dirty,
    node_count: baseline.nodes.length,
  };
}

/**
 * Validate, read, and aggregate the named child projects. The current worktrees are not
 * inspected: the result is explicitly an index of their persisted scan baselines.
 */
export function buildWorkspaceIndex(ownerRoot: string, memberPaths: string[]): WorkspaceIndex {
  if (memberPaths.length === 0) {
    throw new StoreFormatError('workspace index requires one or more member paths');
  }

  const paths = memberPaths.map((path) => {
    memberParts(path);
    return path;
  });
  const duplicatePath = paths.find((path, index) => paths.indexOf(path) !== index);
  if (duplicatePath !== undefined) {
    throw new StoreFormatError(`duplicate workspace member path: ${JSON.stringify(duplicatePath)}`);
  }

  const members = paths.sort(compareCodeUnits).map((path) => loadMember(ownerRoot, path));
  const ids = new Set<string>();
  for (const member of members) {
    if (ids.has(member.project_id)) {
      throw new StoreFormatError(`duplicate workspace project id: ${JSON.stringify(member.project_id)}`);
    }
    ids.add(member.project_id);
  }

  return {
    schema_version: 1,
    command: 'workspace index',
    members,
    summary: {
      member_count: members.length,
      node_count: members.reduce((total, member) => total + member.node_count, 0),
    },
  };
}
