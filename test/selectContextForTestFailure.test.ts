import { describe, it, expect, afterEach } from "vitest";
import { selectContextForTestFailure } from "../src/ai/context/selectContextForTestFailure.js";
import type { FileForSelection } from "../src/ai/context/types.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

function file(relativePath: string, imports: string[] = [], isTest = false): FileForSelection {
  return { relativePath, language: "TypeScript", imports, isTest };
}

describe("selectContextForTestFailure", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("always includes the captured output as the primary item", () => {
    root = makeTempRepo();

    const bundle = selectContextForTestFailure({
      root,
      testRun: {
        id: "run1",
        command: "vitest run",
        framework: "vitest",
        stdout: "FAIL src/a.test.ts\nExpected 2 but got 3",
        stderr: "",
      },
      files: [],
      budgetTokens: 10_000,
    });

    expect(bundle.targetId).toBe("run1");
    const primary = bundle.selected.find((s) => s.path === "(test run output)");
    expect(primary).toBeTruthy();
    expect(primary!.reason).toContain("Captured output");
  });

  it("selects a real file whose path is referenced in the output, ranked test-files-first", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export function add(a: number, b: number) { return a + b; }\n");
    writeFile(root, "src/a.test.ts", "import { add } from './a.js';\ntest('adds', () => add(1, 2));\n");

    const bundle = selectContextForTestFailure({
      root,
      testRun: {
        id: "run1",
        command: "vitest run",
        framework: "vitest",
        stdout: "FAIL src/a.test.ts\nAssertionError: expected 4 to be 3\n  at src/a.test.ts:2:20",
        stderr: "",
      },
      files: [file("src/a.ts"), file("src/a.test.ts", ["./a.js"], true)],
      budgetTokens: 10_000,
    });

    const paths = bundle.selected.map((s) => s.path);
    expect(paths).toContain("src/a.test.ts");
    const testItem = bundle.selected.find((s) => s.path === "src/a.test.ts")!;
    expect(testItem.reason).toMatch(/referenced in the failed test run's output/);
  });

  it("pulls in the top matched test file's own imports as secondary candidates", () => {
    root = makeTempRepo();
    writeFile(root, "src/a.ts", "export function add(a: number, b: number) { return a + b; }\n");
    writeFile(root, "src/a.test.ts", "import { add } from './a.js';\ntest('adds', () => add(1, 2));\n");

    const bundle = selectContextForTestFailure({
      root,
      testRun: {
        id: "run1",
        command: "vitest run",
        framework: "vitest",
        stdout: "FAIL src/a.test.ts\nAssertionError",
        stderr: "",
      },
      files: [file("src/a.ts"), file("src/a.test.ts", ["./a.js"], true)],
      budgetTokens: 10_000,
    });

    const paths = bundle.selected.map((s) => s.path);
    expect(paths).toContain("src/a.ts");
    expect(bundle.selected.find((s) => s.path === "src/a.ts")!.reason).toMatch(/Imported by src\/a\.test\.ts/);
  });

  it("never selects a file whose path never appears in the output", () => {
    root = makeTempRepo();
    writeFile(root, "src/unrelated.ts", "export const z = 1;\n");

    const bundle = selectContextForTestFailure({
      root,
      testRun: {
        id: "run1",
        command: "vitest run",
        framework: "vitest",
        stdout: "FAIL src/a.test.ts\nAssertionError",
        stderr: "",
      },
      files: [file("src/unrelated.ts")],
      budgetTokens: 10_000,
    });

    expect(bundle.selected.map((s) => s.path)).not.toContain("src/unrelated.ts");
  });

  it("redacts secrets in the captured output before it's ever counted toward the budget", () => {
    root = makeTempRepo();

    const bundle = selectContextForTestFailure({
      root,
      testRun: {
        id: "run1",
        command: "vitest run",
        framework: "vitest",
        stdout: 'const apiKey = "sk-verysecretvalue1234567890";\nAssertionError',
        stderr: "",
      },
      files: [],
      budgetTokens: 10_000,
      includeContent: true,
    });

    const primary = bundle.selected.find((s) => s.path === "(test run output)")!;
    expect(primary.content).not.toContain("verysecretvalue1234567890");
  });

  it("truncates the excerpt to fit rather than excluding the output outright when the budget is tight", () => {
    root = makeTempRepo();
    const longOutput = "line of test output noise\n".repeat(500) + "AssertionError: expected 1 to be 2";

    const bundle = selectContextForTestFailure({
      root,
      testRun: { id: "run1", command: "vitest run", framework: "vitest", stdout: longOutput, stderr: "" },
      files: [],
      budgetTokens: 150, // small — forces truncation, but leaves room for the smallest 500-char tail
      includeContent: true,
    });

    const primary = bundle.selected.find((s) => s.path === "(test run output)");
    expect(primary).toBeTruthy();
    expect(primary!.content!.length).toBeLessThan(longOutput.length);
    // The tail (where the real failure detail lives) must survive truncation.
    expect(primary!.content).toContain("AssertionError");
  });

  it("excludes with a reason rather than fabricating content when the run captured no output at all", () => {
    root = makeTempRepo();

    const bundle = selectContextForTestFailure({
      root,
      testRun: { id: "run1", command: "vitest run", framework: "vitest", stdout: "", stderr: "" },
      files: [],
      budgetTokens: 10_000,
    });

    expect(bundle.selected).toEqual([]);
    expect(bundle.excluded[0].reason).toMatch(/no stdout or stderr/);
  });
});
