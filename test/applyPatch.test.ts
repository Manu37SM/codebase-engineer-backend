import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyPatchToDisk } from "../src/patch/applyPatch.js";
import { makeTempRepo, writeFile, initGit, gitCommitAll, cleanupRepo } from "./fixtures.js";

describe("applyPatchToDisk", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot) cleanupRepo(repoRoot);
  });

  it("writes a real, cleanly-applying diff to the working tree", () => {
    repoRoot = makeTempRepo();
    initGit(repoRoot);
    writeFile(repoRoot, "src/a.ts", "const apiKey = 'sk-secret';\nexport const x = 1;\n");
    gitCommitAll(repoRoot, "init");

    const diff =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

    const result = applyPatchToDisk(repoRoot, diff);

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    const content = fs.readFileSync(path.join(repoRoot, "src/a.ts"), "utf-8");
    expect(content).toBe("const apiKey = process.env.API_KEY;\nexport const x = 1;\n");
  });

  it("fails without writing anything when the diff no longer matches the working tree (dry-run catches it)", () => {
    repoRoot = makeTempRepo();
    initGit(repoRoot);
    writeFile(repoRoot, "src/a.ts", "const y = 2;\nexport const x = 1;\n"); // drifted from what the diff expects
    gitCommitAll(repoRoot, "init");

    const diff =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

    const result = applyPatchToDisk(repoRoot, diff);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    const content = fs.readFileSync(path.join(repoRoot, "src/a.ts"), "utf-8");
    expect(content).toBe("const y = 2;\nexport const x = 1;\n"); // untouched — dry-run failure never reaches the real apply
  });

  it("works even without a .git directory — git apply is a plain patch tool, not repo-history-dependent", () => {
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "src/a.ts", "const apiKey = 'sk-secret';\nexport const x = 1;\n");
    // deliberately no initGit() — confirms applyPatchToDisk doesn't assume a real repo exists

    const diff =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

    const result = applyPatchToDisk(repoRoot, diff);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(repoRoot, "src/a.ts"), "utf-8");
    expect(content).toBe("const apiKey = process.env.API_KEY;\nexport const x = 1;\n");
  });

  it("fails cleanly when the diff targets a file that doesn't exist in the working tree", () => {
    repoRoot = makeTempRepo();
    initGit(repoRoot);
    writeFile(repoRoot, "src/other.ts", "export const y = 2;\n");
    gitCommitAll(repoRoot, "init");

    const diff =
      "--- a/src/missing.ts\n+++ b/src/missing.ts\n@@ -1,1 +1,1 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n";

    const result = applyPatchToDisk(repoRoot, diff);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("reports NO_PATCH-shaped or malformed diff text as a clean failure, not a crash", () => {
    repoRoot = makeTempRepo();
    initGit(repoRoot);
    writeFile(repoRoot, "src/a.ts", "const x = 1;\n");
    gitCommitAll(repoRoot, "init");

    const result = applyPatchToDisk(repoRoot, "NO_PATCH: the model declined to produce a diff\n");

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
