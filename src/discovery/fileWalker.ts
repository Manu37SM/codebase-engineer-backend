import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// The `ignore` package ships a CJS default export (`module.exports = factory`)
// whose .d.ts triggers inconsistent esModuleInterop typing under NodeNext
// module resolution. Loading it via createRequire sidesteps that entirely —
// this file's own emitted output is still ESM, only this one import uses the
// Node-native interop path.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ignoreFactory = require("ignore") as (options?: unknown) => IgnoreInstance;

interface IgnoreInstance {
  add(patterns: string | string[]): IgnoreInstance;
  ignores(pathname: string): boolean;
}

type Ignore = IgnoreInstance;

/**
 * Directories that are never scanned, regardless of .gitignore, per
 * docs/PRD.md §3 (Repository Index) and docs/SECURITY.md §3. Keeping this as
 * a fixed list (rather than relying solely on .gitignore) means a repository
 * with no .gitignore still gets sane exclusion behavior.
 */
export const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Files larger than this are skipped when reading content (LOC, etc.). */
export const MAX_READABLE_FILE_BYTES = 2 * 1024 * 1024; // 2MB

export interface WalkedFile {
  /** Absolute path on disk. */
  absPath: string;
  /** POSIX-style path relative to the walk root. */
  relPath: string;
  sizeBytes: number;
}

export interface WalkOptions {
  /**
   * Absolute directory to walk. Caller is responsible for having already
   * validated this via security/paths.ts before calling.
   */
  root: string;
  /** Optional additional relative-path glob patterns to ignore. */
  extraIgnorePatterns?: string[];
}

/**
 * Walks `root` recursively, skipping DEFAULT_EXCLUDED_DIRS and anything
 * matched by .gitignore files found anywhere in the tree (root and nested),
 * plus any extraIgnorePatterns. Symlinks are not followed outside the walk
 * root.
 *
 * Nested .gitignore support is an approximation, not a full git-compatible
 * implementation: each nested .gitignore's patterns are rewritten to be
 * rooted at the directory that contains it (anchored patterns get that
 * directory's prefix; unanchored patterns get both a direct-child and a
 * "anywhere under this directory" variant) and added, in root-to-leaf
 * discovery order, to one shared `ignore` matcher. This correctly handles
 * the common cases (a nested .gitignore excluding its own build output,
 * negating a pattern from a parent) but does not guarantee byte-identical
 * behavior to `git check-ignore` for pathological pattern interactions
 * across many nesting levels. Documented as a known limitation — see
 * docs/SECURITY.md §3 and docs/FEATURE.md.
 */
export function walkRepository(options: WalkOptions): WalkedFile[] {
  const { root } = options;
  const ig = ignoreFactory();
  applyGitignoreAt(ig, root, "");
  if (options.extraIgnorePatterns?.length) {
    ig.add(options.extraIgnorePatterns);
  }

  const results: WalkedFile[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory (permissions) — skip rather than crash
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(root, absPath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
        // Do not follow symlinked directories — avoids escaping the walk
        // root via a crafted symlink (see docs/SECURITY.md §2).
        if (entry.isSymbolicLink()) continue;
        if (ig.ignores(relPath + "/")) continue;

        // Merge this directory's own .gitignore (if any) before descending,
        // so its rules apply to everything below it.
        if (relPath !== "") {
          applyGitignoreAt(ig, absPath, relPath);
        }
        stack.push(absPath);
        continue;
      }

      if (entry.isSymbolicLink()) continue; // never follow file symlinks either
      if (!entry.isFile()) continue;
      if (ig.ignores(relPath)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      results.push({ absPath, relPath, sizeBytes: stat.size });
    }
  }

  return results;
}

/**
 * Reads `<dir>/.gitignore` (if present) and adds its patterns to `ig`,
 * rewritten to be rooted at `dirRelPath` (posix, relative to the walk root;
 * "" for the walk root itself).
 */
function applyGitignoreAt(ig: Ignore, dirAbsPath: string, dirRelPath: string): void {
  const gitignorePath = path.join(dirAbsPath, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;

  let contents: string;
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    return; // unreadable .gitignore — proceed without it
  }

  const rewritten = contents
    .split("\n")
    .map((line) => rewritePatternForSubdir(line, dirRelPath))
    .filter((line): line is string => line !== null)
    .flatMap((line) => line.split("\n"));

  if (rewritten.length > 0) {
    ig.add(rewritten);
  }
}

function rewritePatternForSubdir(rawLine: string, dirRelPath: string): string | null {
  const line = rawLine.replace(/\r$/, "");
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (dirRelPath === "") return line; // root .gitignore — no rewriting needed

  const negated = trimmed.startsWith("!");
  const pattern = negated ? trimmed.slice(1) : trimmed;
  const prefix = negated ? "!" : "";

  const isAnchored = pattern.startsWith("/");
  const bare = isAnchored ? pattern.slice(1) : pattern;

  if (isAnchored || bare.includes("/")) {
    // Already anchored to this directory (leading slash, or a slash
    // anywhere but the end per gitignore semantics).
    return `${prefix}${dirRelPath}/${bare}`;
  }

  // Unanchored simple pattern (e.g. "*.log") — matches at this directory
  // level and at any depth below it.
  return `${prefix}${dirRelPath}/${bare}\n${prefix}${dirRelPath}/**/${bare}`;
}

/** Reads a file's text content, or null if it's too large or unreadable/binary. */
export function readTextFileSafe(absPath: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_READABLE_FILE_BYTES) return null;
  try {
    const buffer = fs.readFileSync(absPath);
    // Cheap binary heuristic: a NUL byte in the first 8000 bytes.
    const sampleLength = Math.min(buffer.length, 8000);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) return null;
    }
    return buffer.toString("utf-8");
  } catch {
    return null;
  }
}
