import fs from "node:fs";
import path from "node:path";

/**
 * Detects JS/TS package managers by lockfile presence, per docs/PRD.md §3.
 * Order matters only for tie-break display; all matching managers are
 * returned (a repo could technically have stray multiple lockfiles, which is
 * itself worth surfacing rather than hiding).
 */
const LOCKFILE_RULES: { file: string; manager: string }[] = [
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
];

export function detectPackageManagers(root: string): string[] {
  const found: string[] = [];
  for (const rule of LOCKFILE_RULES) {
    if (fs.existsSync(path.join(root, rule.file))) {
      found.push(rule.manager);
    }
  }
  return found;
}
