/**
 * Project name derivation (FR-8): the git repository name when there is one,
 * otherwise the working directory name. No configuration, no naming scheme
 * assumptions, no shelling out to git.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function gitRoot(startDir, exists = existsSync) {
  let dir = startDir;
  // Walk up until `.git` is found or the filesystem root is reached.
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function deriveProject(cwd, exists = existsSync) {
  if (!cwd) return 'unknown';
  const root = gitRoot(cwd, exists);
  return basename(root || cwd) || 'unknown';
}
