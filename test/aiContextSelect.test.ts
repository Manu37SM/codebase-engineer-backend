import { describe, it, expect, afterEach } from "vitest";
import { selectContextForFinding } from "../src/ai/context/select.js";
import type { FileForSelection } from "../src/ai/context/types.js";
import { makeTempRepo, writeFile, cleanupRepo, initGit, gitCommitAll } from "./fixtures.js";

function file(relativePath: string, imports: string[] = [], isTest = false): FileForSelection {
  return { relativePath, language: "TypeScript", imports, isTest };
}

describe("selectContextForFinding", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("selects the full primary file when it fits the budget, with no Git repo present", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 2, lineEnd: 2 },
      files: [file("src/a.ts")],
      budgetTokens: 10_000,
    });

    expect(bundle.targetId).toBe("f1");
    expect(bundle.selected.map((s) => s.path)).toContain("src/a.ts");
    const primary = bundle.selected.find((s) => s.path === "src/a.ts")!;
    expect(primary.reason).toContain("Directly affected file");
    expect(bundle.totalTokens).toBeGreaterThan(0);
    expect(bundle.excluded).toEqual([]);
  });

  it("includes an imported file and a known caller, each with a distinct reason", () => {
    root = makeTempRepo();
    writeFile(root, "src/util.ts", "export function helper() { return 1; }\n");
    writeFile(root, "src/a.ts", "import { helper } from './util.js';\nexport function use() { return helper(); }\n");
    writeFile(root, "src/caller.ts", "import { use } from './a.js';\nuse();\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 2, lineEnd: 2 },
      files: [
        file("src/util.ts"),
        file("src/a.ts", ["./util.js"]),
        file("src/caller.ts", ["./a.js"]),
      ],
      budgetTokens: 10_000,
    });

    const paths = bundle.selected.map((s) => s.path);
    expect(paths).toContain("src/util.ts");
    expect(paths).toContain("src/caller.ts");
    expect(bundle.selected.find((s) => s.path === "src/util.ts")!.reason).toMatch(/Imported by/);
    expect(bundle.selected.find((s) => s.path === "src/caller.ts")!.reason).toMatch(/known caller/);
  });

  it("includes a circularly-importing file only once, not twice", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "import { b } from './b.js';\nexport function a() { return b(); }\n");
    writeFile(root, "src/b.ts", "import { a } from './a.js';\nexport function b() { return 1; }\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 2, lineEnd: 2 },
      files: [file("src/a.ts", ["./b.js"]), file("src/b.ts", ["./a.js"])],
      budgetTokens: 10_000,
      includeContent: true,
    });

    const bMatches = bundle.selected.filter((s) => s.path === "src/b.ts");
    expect(bMatches).toHaveLength(1);

    expect(bMatches[0].reason).toMatch(/Imported by/);
  });

  it("prefers a test file that imports the primary file over a naming-convention guess", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export function add(a: number, b: number) { return a + b; }\n");
    writeFile(root, "src/a.test.ts", "import { add } from './a.js';\ntest('adds', () => add(1, 2));\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts"), file("src/a.test.ts", ["./a.js"], true)],
      budgetTokens: 10_000,
    });

    const testItem = bundle.selected.find((s) => s.path === "src/a.test.ts");
    expect(testItem).toBeTruthy();
    expect(testItem!.reason).toMatch(/Test file that imports/);
  });

  it("falls back to naming-convention test discovery when no test file imports the primary file", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export function add(a: number, b: number) { return a + b; }\n");
    writeFile(root, "src/a.test.ts", "test('adds', () => {});\n"); 

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts"), file("src/a.test.ts", [], true)],
      budgetTokens: 10_000,
    });

    const testItem = bundle.selected.find((s) => s.path === "src/a.test.ts");
    expect(testItem).toBeTruthy();
    expect(testItem!.reason).toMatch(/naming convention/);
  });

  it("includes the project's package.json as relevant config", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export const x = 1;\n");
    writeFile(root, "package.json", JSON.stringify({ name: "fixture" }));

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts"), file("package.json")],
      budgetTokens: 10_000,
    });

    expect(bundle.selected.find((s) => s.path === "package.json")).toBeTruthy();
  });

  it("includes a real uncommitted Git diff hunk for the primary file when one exists", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "src/a.ts", "export const x = 1;\n");
    gitCommitAll(root, "initial");
    writeFile(root, "src/a.ts", "export const x = 1;\nexport const y = 2;\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts")],
      budgetTokens: 10_000,
    });

    const diffItem = bundle.selected.find((s) => s.path === "src/a.ts (uncommitted diff)");
    expect(diffItem).toBeTruthy();
    expect(diffItem!.reason).toMatch(/Uncommitted changes/);
  });

  it("does not include a Git-diff item when there are no uncommitted changes", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "src/a.ts", "export const x = 1;\n");
    gitCommitAll(root, "initial");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts")],
      budgetTokens: 10_000,
    });

    expect(bundle.selected.find((s) => s.path.includes("uncommitted diff"))).toBeUndefined();
  });

  it("redacts a hardcoded secret in the primary file before it's ever counted or returned", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", 'const apiKey = "sk-verysecretvalue1234";\nexport const x = 1;\n');

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts")],
      budgetTokens: 10_000,
    });

    expect(JSON.stringify(bundle)).not.toContain("verysecretvalue1234");
  });

  it("windows the primary file around the finding when the full file doesn't fit the budget", () => {
    root = makeTempRepo();
    const lines = Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`);
    lines[249] = "throw new Error('boom');"; 
    writeFile(root, "src/big.ts", lines.join("\n") + "\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/big.ts", lineStart: 250, lineEnd: 250 },
      files: [file("src/big.ts")],
      budgetTokens: 200, 
    });

    const primary = bundle.selected.find((s) => s.path === "src/big.ts");
    expect(primary).toBeTruthy();
    expect(primary!.reason).toMatch(/showing lines/);
    expect(primary!.tokens).toBeLessThanOrEqual(200);
  });

  it("excludes the primary file honestly when even a small window can't fit the budget", () => {
    root = makeTempRepo();
    const lines = Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`);
    writeFile(root, "src/big.ts", lines.join("\n") + "\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/big.ts", lineStart: 250, lineEnd: 250 },
      files: [file("src/big.ts")],
      budgetTokens: 1, 
    });

    expect(bundle.selected).toEqual([]);
    const excludedPrimary = bundle.excluded.find((e) => e.path === "src/big.ts");
    expect(excludedPrimary).toBeTruthy();
    expect(excludedPrimary!.reason).toMatch(/exceeds the remaining context budget/);
  });

  it("excludes secondary candidates honestly when the budget runs out, with a real token count in the reason", () => {
    root = makeTempRepo();
    writeFile(root, "src/util.ts", `// ${"padding ".repeat(300)}\nexport function helper() { return 1; }\n`);
    writeFile(root, "src/a.ts", "import { helper } from './util.js';\nexport function use() { return helper(); }\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/a.ts", lineStart: 2, lineEnd: 2 },
      files: [file("src/util.ts"), file("src/a.ts", ["./util.js"])],

      budgetTokens: 40,
    });

    expect(bundle.selected.find((s) => s.path === "src/a.ts")).toBeTruthy();
    const excludedUtil = bundle.excluded.find((e) => e.path === "src/util.ts");
    expect(excludedUtil).toBeTruthy();
    expect(excludedUtil!.reason).toMatch(/Excluded: needs ~\d+ tokens, \d+ remaining/);
  });

  it("reports a real error for a finding whose file is no longer in the index", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export const x = 1;\n");

    const bundle = selectContextForFinding({
      root,
      finding: { id: "f1", filePath: "src/deleted.ts", lineStart: 1, lineEnd: 1 },
      files: [file("src/a.ts")],
      budgetTokens: 10_000,
    });

    expect(bundle.selected).toEqual([]);
    expect(bundle.excluded[0].path).toBe("src/deleted.ts");
    expect(bundle.excluded[0].reason).toMatch(/not in the current index/);
  });
});
