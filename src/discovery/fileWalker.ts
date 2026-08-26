import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ignoreFactory = require("ignore") as (options?: unknown) => IgnoreInstance;

interface IgnoreInstance {
  add(patterns: string | string[]): IgnoreInstance;
  ignores(pathname: string): boolean;
}

type Ignore = IgnoreInstance;

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

export const MAX_READABLE_FILE_BYTES = 2 * 1024 * 1024; 

export interface WalkedFile {

  absPath: string;

  relPath: string;
  sizeBytes: number;
}

export interface WalkOptions {

  root: string;

  extraIgnorePatterns?: string[];
}

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
      continue; 
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(root, absPath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;

        if (entry.isSymbolicLink()) continue;
        if (ig.ignores(relPath + "/")) continue;

        if (relPath !== "") {
          applyGitignoreAt(ig, absPath, relPath);
        }
        stack.push(absPath);
        continue;
      }

      if (entry.isSymbolicLink()) continue; 
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

function applyGitignoreAt(ig: Ignore, dirAbsPath: string, dirRelPath: string): void {
  const gitignorePath = path.join(dirAbsPath, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;

  let contents: string;
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    return; 
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
  if (dirRelPath === "") return line; 

  const negated = trimmed.startsWith("!");
  const pattern = negated ? trimmed.slice(1) : trimmed;
  const prefix = negated ? "!" : "";

  const isAnchored = pattern.startsWith("/");
  const bare = isAnchored ? pattern.slice(1) : pattern;

  if (isAnchored || bare.includes("/")) {

    return `${prefix}${dirRelPath}/${bare}`;
  }

  return `${prefix}${dirRelPath}/${bare}\n${prefix}${dirRelPath}/**/${bare}`;
}

export function readTextFileSafe(absPath: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_READABLE_FILE_BYTES) return null;
  try {
    const buffer = fs.readFileSync(absPath);

    const sampleLength = Math.min(buffer.length, 8000);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) return null;
    }
    return buffer.toString("utf-8");
  } catch {
    return null;
  }
}
