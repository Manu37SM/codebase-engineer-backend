import path from "node:path";
import fs from "node:fs";

export class PathTraversalError extends Error {
  constructor(target: string) {
    super(`Path escapes the project root: ${target}`);
    this.name = "PathTraversalError";
  }
}

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
