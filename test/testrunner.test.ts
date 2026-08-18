import { describe, it, expect, afterEach } from "vitest";
import { detectTestCommand } from "../src/testrunner/detect.js";
import { runTests } from "../src/testrunner/run.js";
import { parseVitestOutput, parseMavenOutput } from "../src/testrunner/parse.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("detectTestCommand", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("detects Maven from pom.xml", () => {
    root = makeTempRepo();
    writeFile(root, "pom.xml", "<project></project>\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "maven", command: "mvn", args: ["-B", "-q", "test"] });
  });

  it("detects Vitest when it's a declared dependency", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.0.0" } })
    );

    const result = detectTestCommand(root);
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("vitest");
    expect(result.command).toBe("npm");
    expect(result.args).toEqual(["run", "test"]);
  });

  it("falls back to a generic npm-script framework when vitest isn't declared", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "jest" } }));

    const result = detectTestCommand(root);
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("npm-script");
  });

  it("prefers the detected lockfile's package manager", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '6.0'\n");

    const result = detectTestCommand(root);
    expect(result.command).toBe("pnpm");
    expect(result.args).toEqual(["run", "test"]);
  });

  it("uses a bare 'test' arg for yarn", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFile(root, "yarn.lock", "# yarn lockfile v1\n");

    const result = detectTestCommand(root);
    expect(result.command).toBe("yarn");
    expect(result.args).toEqual(["test"]);
  });

  it("reports unsupported when package.json has no test script", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { build: "vite build" } }));

    const result = detectTestCommand(root);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/No test script/);
  });

  it("reports unsupported for the default npm-init placeholder test script", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    );

    const result = detectTestCommand(root);
    expect(result.supported).toBe(false);
  });

  it("reports unsupported (with reason) for a Gradle-only project", () => {
    root = makeTempRepo();
    writeFile(root, "build.gradle", "plugins { id 'java' }\n");

    const result = detectTestCommand(root);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/Gradle/);
  });

  it("reports unsupported for a repo with no recognized build system", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "hello\n");

    const result = detectTestCommand(root);
    expect(result.supported).toBe(false);
  });
});

describe("parseVitestOutput", () => {
  it("parses a plain (uncolored) summary line", () => {
    const output = "Test Files  1 passed (1)\nTests  5 passed (5)\n";
    expect(parseVitestOutput(output)).toEqual({ passed: 5, failed: 0, skipped: 0 });
  });

  it("parses failures and skips alongside passes", () => {
    const output = "Tests  3 failed | 5 passed | 1 skipped (9)\n";
    expect(parseVitestOutput(output)).toEqual({ passed: 5, failed: 3, skipped: 1 });
  });

  it("parses a real ANSI-colored Vitest summary line (regression — see run.ts dogfooding note)", () => {
    // Captured shape from a real `npm test` run: the "Tests" label itself is
    // wrapped in a dim escape code, which broke a line-start-anchored regex
    // that didn't strip ANSI codes first.
    const output =
      "[2m Test Files [22m [1m[32m10 passed[39m[22m[90m (10)[39m\n" +
      "[2m      Tests [22m [1m[32m77 passed[39m[22m[90m (77)[39m\n";
    expect(parseVitestOutput(output)).toEqual({ passed: 77, failed: 0, skipped: 0 });
  });

  it("returns null counts (not zeros) when no summary line is found", () => {
    expect(parseVitestOutput("some unrelated output\n")).toEqual({
      passed: null,
      failed: null,
      skipped: null,
    });
  });
});

describe("parseMavenOutput", () => {
  it("parses a single Surefire summary line", () => {
    const output = "Tests run: 12, Failures: 1, Errors: 0, Skipped: 2\n";
    expect(parseMavenOutput(output)).toEqual({ passed: 9, failed: 1, skipped: 2 });
  });

  it("sums multiple module summary lines in a multi-module build", () => {
    const output =
      "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\n" +
      "Tests run: 7, Failures: 1, Errors: 1, Skipped: 1\n";
    // module 1: 5 passed; module 2: 7 run, 1 failure + 1 error = 2 failed, 1 skipped, 4 passed
    expect(parseMavenOutput(output)).toEqual({ passed: 9, failed: 2, skipped: 1 });
  });

  it("returns null counts when no summary line is found", () => {
    expect(parseMavenOutput("BUILD FAILURE\nsome unrelated error\n")).toEqual({
      passed: null,
      failed: null,
      skipped: null,
    });
  });
});

describe("runTests — real process execution", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("reports supported:false without spawning anything for an unsupported project", async () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "hello\n");

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(false);
    expect(outcome.reason).toBeTruthy();
    expect(outcome.exitCode).toBeNull();
  });

  it("actually runs a passing npm test script and captures stdout + exit code", async () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "node -e \"console.log('hello from test')\"" } })
    );

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.framework).toBe("npm-script");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("hello from test");
    // Framework is generic npm-script — counts are honestly unknown, not fabricated.
    expect(outcome.passed).toBeNull();
  });

  it("actually runs a failing npm test script and reports a non-zero exit code", async () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.exitCode).toBe(1);
  });

  it("kills a long-running command on timeout and reports timedOut", async () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "node -e \"setTimeout(() => {}, 60000)\"" } })
    );

    const outcome = await runTests(root, { timeoutMs: 300 });
    expect(outcome.timedOut).toBe(true);
  }, 10_000);
});
