import { describe, it, expect, afterEach } from "vitest";
import { indexRepository } from "../src/indexer/index.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("indexRepository", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("indexes files with language, LOC, size, hash, and test/generated classification", () => {
    root = makeTempRepo();
    writeFile(root, "src/util.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    writeFile(root, "src/util.test.ts", "import { add } from './util';\ntest('adds', () => { add(1, 2); });\n");
    writeFile(root, "src/generated/schema.generated.ts", "// content\nexport const x = 1;\n");
    writeFile(root, "README.md", "# not a source file\n");

    const result = indexRepository(root);

    expect(result.totalFiles).toBe(4);
    expect(result.testFiles).toBe(1);
    expect(result.generatedFiles).toBe(1);

    const util = result.files.find((f) => f.relativePath === "src/util.ts")!;
    expect(util.language).toBe("TypeScript");
    expect(util.loc).toBe(3);
    expect(util.isTest).toBe(false);
    expect(util.isGenerated).toBe(false);
    expect(util.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const testFile = result.files.find((f) => f.relativePath === "src/util.test.ts")!;
    expect(testFile.isTest).toBe(true);
    expect(testFile.imports).toContain("./util");

    const generatedFile = result.files.find(
      (f) => f.relativePath === "src/generated/schema.generated.ts"
    )!;
    expect(generatedFile.isGenerated).toBe(true);

    const readme = result.files.find((f) => f.relativePath === "README.md")!;
    expect(readme.language).toBeNull();
  });

  it("produces a different content hash when file content changes", () => {
    root = makeTempRepo();
    writeFile(root, "a.ts", "export const a = 1;\n");
    const first = indexRepository(root).files[0].contentHash;

    writeFile(root, "a.ts", "export const a = 2;\n");
    const second = indexRepository(root).files[0].contentHash;

    expect(first).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("extracts Java imports", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "src/main/java/com/example/App.java",
      "package com.example;\n\nimport java.util.List;\nimport static java.util.Collections.emptyList;\n\npublic class App {}\n"
    );

    const result = indexRepository(root);
    const file = result.files[0];
    expect(file.imports).toEqual(
      expect.arrayContaining(["java.util.List", "java.util.Collections.emptyList"])
    );
  });

  it("classifies Java test files by naming convention", () => {
    root = makeTempRepo();
    writeFile(root, "src/main/java/com/example/App.java", "public class App {}\n");
    writeFile(root, "src/test/java/com/example/AppTest.java", "public class AppTest {}\n");

    const result = indexRepository(root);
    const app = result.files.find((f) => f.relativePath.endsWith("App.java"))!;
    const appTest = result.files.find((f) => f.relativePath.endsWith("AppTest.java"))!;
    expect(app.isTest).toBe(false);
    expect(appTest.isTest).toBe(true);
  });
});
