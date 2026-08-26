import fs from "node:fs";
import path from "node:path";

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
