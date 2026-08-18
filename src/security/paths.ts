import path from "node:path";
import fs from "node:fs";

export class PathTraversalError extends Error {
  constructor(target: string) {
    super(`Path escapes the project root: ${target}`);
    this.name = "PathTraversalError";
  }
}

/**
 * Resolves `target` (relative or absolute) against `root` and verifies the
 * resolved absolute path is `root` itself or a descendant of it. Throws
 * PathTraversalError otherwise. Never silently clamps a path back inside the
 * root — callers must treat a thrown error as "reject the request".
 *
 * This is the single choke point all filesystem access in the backend must
 * go through for anything scoped to a registered project. See
 * docs/SECURITY.md §2.
 */
export function resolveWithinRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedRoot, target);

  const relative = path.relative(resolvedRoot, resolvedTarget);
  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (escapes) {
    throw new PathTraversalError(target);
  }

  return resolvedTarget;
}

/**
 * Validates that `root` is an existing, absolute, directory path suitable for
 * registration as a project root. Does not create it.
 */
export function assertValidProjectRoot(root: string): void {
  if (!path.isAbsolute(root)) {
    throw new Error(`Project root must be an absolute path: ${root}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`Project root does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }
}
