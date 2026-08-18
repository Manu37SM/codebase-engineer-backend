#!/usr/bin/env node
// Cross-platform replacement for `mkdir -p dist/db/migrations && cp
// src/db/migrations/*.sql dist/db/migrations/` — that shell pipeline only
// works under a POSIX shell (bash/sh/zsh). On Windows, npm's default shell
// is cmd.exe, which doesn't understand `mkdir -p`, `cp`, or the `*.sql`
// glob, so `npm run build` failed there with "The syntax of the command is
// incorrect." even though the exact same script worked fine in this
// project's Linux development environment. Plain Node.js `fs` calls work
// identically on every platform this product supports (Windows/macOS/
// Linux), so this replaces the shell pipeline entirely rather than trying
// to make the shell command itself portable (e.g. via `shx`), keeping the
// build free of an extra dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const srcDir = path.join(projectRoot, "src", "db", "migrations");
const destDir = path.join(projectRoot, "dist", "db", "migrations");

fs.mkdirSync(destDir, { recursive: true });

const migrationFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".sql"));
for (const file of migrationFiles) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

console.log(`Copied ${migrationFiles.length} migration file(s) to ${path.relative(projectRoot, destDir)}`);
