import { describe, it, expect, afterEach } from "vitest";
import { walkRepository } from "../src/discovery/fileWalker.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("walkRepository — nested .gitignore", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("honors a .gitignore in a subdirectory, not just the root", () => {
    root = makeTempRepo();
    writeFile(root, "packages/app/.gitignore", "*.local.ts\n");
    writeFile(root, "packages/app/src/keep.ts", "export const a = 1;\n");
    writeFile(root, "packages/app/src/secret.local.ts", "export const b = 2;\n");

    writeFile(root, "packages/other/secret.local.ts", "export const c = 3;\n");

    const files = walkRepository({ root }).map((f) => f.relPath).sort();

    expect(files).toContain("packages/app/src/keep.ts");
    expect(files).not.toContain("packages/app/src/secret.local.ts");
    expect(files).toContain("packages/other/secret.local.ts");
  });

  it("honors an anchored nested pattern (leading slash relative to its own directory)", () => {
    root = makeTempRepo();
    writeFile(root, "pkg/.gitignore", "/build-notes.md\n");
    writeFile(root, "pkg/build-notes.md", "ignored at pkg root\n");
    writeFile(root, "pkg/nested/build-notes.md", "not ignored — anchored to pkg/, not pkg/nested/\n");

    const files = walkRepository({ root }).map((f) => f.relPath).sort();

    expect(files).not.toContain("pkg/build-notes.md");
    expect(files).toContain("pkg/nested/build-notes.md");
  });

  it("still applies the root .gitignore to files outside any nested directory", () => {
    root = makeTempRepo();
    writeFile(root, ".gitignore", "*.log\n");
    writeFile(root, "app.log", "noise\n");
    writeFile(root, "keep.ts", "export const a = 1;\n");

    const files = walkRepository({ root }).map((f) => f.relPath).sort();
    expect(files).not.toContain("app.log");
    expect(files).toContain("keep.ts");
  });
});
