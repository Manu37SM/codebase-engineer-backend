import path from "node:path";
import { walkRepository } from "./fileWalker.js";

/**
 * Multi-project-in-folder detection (Task #87) — some registered/imported
 * folders (a monorepo, a "Download ZIP" of an organization's umbrella
 * repo, a folder someone points at that turns out to hold several
 * unrelated projects) actually contain more than one independent project.
 * This scans for the usual per-language "this directory is a project
 * root" marker files and reports every directory that has one, so the UI
 * can offer to register a specific sub-directory as its own project
 * instead of (or in addition to) the whole folder.
 *
 * Reuses `walkRepository` (the same gitignore-aware, `node_modules`/`.git`
 * -excluding walker the rest of discovery/indexing already uses) rather
 * than a bespoke directory walk, so a marker file buried inside
 * `node_modules` (a dependency's own `package.json`, extremely common)
 * never shows up as a false "sub-project".
 */

const MARKER_FILE_NAMES = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "*.sln", // handled specially below (extension match, not exact name)
]);

/** Cap on how many candidate sub-project directories are reported — generous, but not unbounded for a pathological input. */
const MAX_CANDIDATES = 100;

function isMarkerFile(fileName: string): string | null {
  if (MARKER_FILE_NAMES.has(fileName)) return fileName;
  if (fileName.endsWith(".csproj")) return "*.csproj";
  if (fileName.endsWith(".sln")) return "*.sln";
  return null;
}

export interface SubProjectCandidate {
  /** POSIX-style path relative to the scanned root; "" means the root itself. */
  relativePath: string;
  /** Marker file name(s) found directly in this directory, e.g. ["package.json"]. */
  markers: string[];
}

export interface MultiProjectDetectionResult {
  /**
   * True when there's more than one plausible independent project root
   * under `root` — i.e. more than one directory (root itself counts) has
   * at least one marker file. A single-marker-at-root folder (the
   * overwhelmingly common case) is `false`.
   */
  isMultiProject: boolean;
  /** Every directory (root-relative) that has at least one marker file, root-to-leaf, root first when present. */
  candidates: SubProjectCandidate[];
  /** True if `candidates` was capped at `MAX_CANDIDATES` — some matches were not included. */
  truncated: boolean;
}

/**
 * Scans `root` (an already-validated absolute path — callers must have run
 * this through `assertValidProjectRoot`/`resolveWithinRoot` first, same as
 * every other discovery entry point) for project-marker files at any
 * depth, and groups them by directory.
 */
export function detectSubProjects(root: string): MultiProjectDetectionResult {
  const files = walkRepository({ root });

  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const fileName = path.posix.basename(file.relPath);
    const marker = isMarkerFile(fileName);
    if (!marker) continue;

    const dir = path.posix.dirname(file.relPath);
    const dirKey = dir === "." ? "" : dir;
    if (!byDir.has(dirKey)) byDir.set(dirKey, new Set());
    byDir.get(dirKey)!.add(marker);
  }

  const allCandidates: SubProjectCandidate[] = Array.from(byDir.entries())
    .map(([relativePath, markers]) => ({ relativePath, markers: Array.from(markers).sort() }))
    .sort((a, b) => {
      // Root first, then shallowest-to-deepest, then alphabetical.
      if (a.relativePath === "") return -1;
      if (b.relativePath === "") return 1;
      const depthDiff = a.relativePath.split("/").length - b.relativePath.split("/").length;
      if (depthDiff !== 0) return depthDiff;
      return a.relativePath.localeCompare(b.relativePath);
    });

  const truncated = allCandidates.length > MAX_CANDIDATES;
  const candidates = truncated ? allCandidates.slice(0, MAX_CANDIDATES) : allCandidates;

  return {
    isMultiProject: allCandidates.length > 1,
    candidates,
    truncated,
  };
}
