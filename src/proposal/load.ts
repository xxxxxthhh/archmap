import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export class ProposalLoadError extends Error {}

/** Read an external proposal without following symlinks or accepting tracked `.archmap` input. */
export function loadProposalFile(path: string, projectRoot: string): unknown {
  const absolute = resolve(path);
  const projectRelative = relative(resolve(projectRoot), absolute).split(sep).join('/');
  if (projectRelative === '.archmap' || projectRelative.startsWith('.archmap/')) {
    throw new ProposalLoadError('proposal input must be external to .archmap');
  }

  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (cause) {
    throw new ProposalLoadError(`cannot read proposal file: ${path}`, { cause });
  }
  if (real !== absolute) {
    throw new ProposalLoadError(`refusing symlinked proposal path: ${path}`);
  }
  try {
    if (!lstatSync(absolute).isFile()) throw new ProposalLoadError(`proposal path is not a regular file: ${path}`);
  } catch (cause) {
    if (cause instanceof ProposalLoadError) throw cause;
    throw new ProposalLoadError(`cannot read proposal file: ${path}`, { cause });
  }

  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw new ProposalLoadError(`cannot read proposal file: ${path}`, { cause });
  }
  let raw: string;
  try {
    raw = readFileSync(fd, 'utf8');
  } catch (cause) {
    closeQuiet(fd);
    throw new ProposalLoadError(`cannot read proposal file: ${path}`, { cause });
  }
  try {
    closeSync(fd);
  } catch (cause) {
    throw new ProposalLoadError(`cannot close proposal file: ${path}`, { cause });
  }

  const extension = extname(absolute).toLowerCase();
  try {
    if (extension === '.json') return JSON.parse(raw);
    if (extension === '.yaml' || extension === '.yml') return parseYaml(raw);
  } catch (cause) {
    throw new ProposalLoadError(`cannot parse proposal file: ${path}`, { cause });
  }
  throw new ProposalLoadError(`unsupported proposal extension "${extension}" (${path})`);
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Preserve the primary read error.
  }
}
