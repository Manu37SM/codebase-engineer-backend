import fs from "node:fs";
import path from "node:path";
import type { DependencyInfo, DuplicateVersionGroup } from "./types.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function parsePackageJsonDependencies(root: string): DependencyInfo[] {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return []; // malformed package.json — nothing to honestly report
  }

  const direct: DependencyInfo[] = [];
  for (const [name, versionRange] of Object.entries(pkg.dependencies ?? {})) {
    direct.push({ name, versionRange, type: "dependency" });
  }
  for (const [name, versionRange] of Object.entries(pkg.devDependencies ?? {})) {
    direct.push({ name, versionRange, type: "devDependency" });
  }
  return direct;
}

interface LockPackageEntry {
  version?: string;
}

interface PackageLockJson {
  lockfileVersion?: number;
  packages?: Record<string, LockPackageEntry>;
}

/**
 * Detects packages resolved at more than one distinct version across the
 * dependency tree, using npm lockfile v2/v3's flat `packages` map (the
 * format written by npm 7+, keyed by node_modules path — e.g.
 * `node_modules/lodash` or a nested
 * `node_modules/some-pkg/node_modules/lodash` for a version conflict).
 * Older lockfileVersion 1 (nested `dependencies` tree, npm <7) isn't
 * parsed — returns an empty list with a note explaining why, rather than
 * fabricating results from a format this doesn't understand.
 */
export function findDuplicateVersions(root: string): {
  duplicates: DuplicateVersionGroup[];
  source: string | null;
  note: string | null;
} {
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    return { duplicates: [], source: null, note: "No package-lock.json found." };
  }

  let lock: PackageLockJson;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {
    return { duplicates: [], source: "package-lock.json", note: "package-lock.json could not be parsed as JSON." };
  }

  if (!lock.packages || (lock.lockfileVersion ?? 0) < 2) {
    return {
      duplicates: [],
      source: "package-lock.json",
      note: "Lockfile is version 1 (pre-npm-7 nested format) — duplicate-version detection currently only supports the v2/v3 flat 'packages' format.",
    };
  }

  const versionsByName = new Map<string, Set<string>>();
  for (const [pkgPath, entry] of Object.entries(lock.packages)) {
    if (pkgPath === "" || !entry.version) continue; // "" is the root project itself
    const name = packageNameFromLockPath(pkgPath);
    if (!name) continue;
    if (!versionsByName.has(name)) versionsByName.set(name, new Set());
    versionsByName.get(name)!.add(entry.version);
  }

  const duplicates: DuplicateVersionGroup[] = [];
  for (const [name, versions] of versionsByName.entries()) {
    if (versions.size > 1) {
      duplicates.push({ name, versions: Array.from(versions).sort() });
    }
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name));

  return { duplicates, source: "package-lock.json", note: null };
}

/** Extracts a package name from a lockfile v2/v3 packages-map key, e.g. "node_modules/a/node_modules/@scope/b" -> "@scope/b". */
function packageNameFromLockPath(lockPath: string): string | null {
  const segments = lockPath.split("node_modules/");
  const last = segments[segments.length - 1];
  return last || null;
}
