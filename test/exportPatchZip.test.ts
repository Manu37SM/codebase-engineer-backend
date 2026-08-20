import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import AdmZip from "adm-zip";
import { buildPatchZip, PatchZipExportError } from "../src/patch/exportPatchZip.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("buildPatchZip (Task #90 — download-instead-of-apply)", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot) cleanupRepo(repoRoot);
  });

  it("builds a real zip containing the patched file content, without touching the real project files", () => {
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "src/config.ts", "const apiKey = 'sk-secret';\nexport const x = 1;\n");

    const diff =
      "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,2 +1,2 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

    const zipBuffer = buildPatchZip(repoRoot, diff);
    expect(zipBuffer.length).toBeGreaterThan(0);

    // The real file is untouched.
    expect(fs.readFileSync(`${repoRoot}/src/config.ts`, "utf-8")).toBe("const apiKey = 'sk-secret';\nexport const x = 1;\n");

    // The zip has the patched content instead.
    const zip = new AdmZip(zipBuffer);
    const entry = zip.getEntry("src/config.ts");
    expect(entry).toBeTruthy();
    expect(zip.readAsText(entry!)).toBe("const apiKey = process.env.API_KEY;\nexport const x = 1;\n");
  });

  it("handles a diff that creates a brand-new file", () => {
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "README.md", "# hello\n");

    const diff =
      "--- /dev/null\n+++ b/src/new-file.ts\n@@ -0,0 +1,2 @@\n+export const greeting = 'hi';\n+console.log(greeting);\n";

    const zipBuffer = buildPatchZip(repoRoot, diff);
    const zip = new AdmZip(zipBuffer);
    const entry = zip.getEntry("src/new-file.ts");
    expect(entry).toBeTruthy();
    expect(zip.readAsText(entry!)).toContain("export const greeting");

    // The real project directory never got the new file.
    expect(fs.existsSync(`${repoRoot}/src/new-file.ts`)).toBe(false);
  });

  it("throws when the diff no longer applies cleanly against the real current content", () => {
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "src/config.ts", "const y = 'drifted';\n");

    const diff =
      "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,1 +1,1 @@\n-const apiKey = 'sk-secret';\n+const apiKey = process.env.API_KEY;\n";

    expect(() => buildPatchZip(repoRoot, diff)).toThrow(PatchZipExportError);
  });

  it("throws a clear error for malformed diff text rather than crashing", () => {
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "README.md", "# hello\n");

    expect(() => buildPatchZip(repoRoot, "NO_PATCH: the model declined to produce a diff\n")).toThrow(
      PatchZipExportError
    );
  });
});
