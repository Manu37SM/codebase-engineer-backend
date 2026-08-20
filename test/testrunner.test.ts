import { describe, it, expect, afterEach } from "vitest";
import spawn from "cross-spawn";
import { detectTestCommand } from "../src/testrunner/detect.js";
import { runTests } from "../src/testrunner/run.js";
import {
  parseVitestOutput,
  parseMavenOutput,
  parseNodeTestOutput,
  parsePytestOutput,
  parseRspecOutput,
  parseGoTestOutput,
  parseDotnetTestOutput,
} from "../src/testrunner/parse.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

/**
 * Whether a real, invocable `cmd` exists on this machine's PATH — used to
 * skip (not fail) the "actually runs <toolchain>" real-process-execution
 * tests when that toolchain genuinely isn't installed here. The detection
 * logic these tests exercise (`detectTestCommand`) only looks at project
 * marker files, not at whether the binary is actually present — real CI
 * environments and contributors' machines legitimately won't all have
 * every one of Maven/Go/.NET/RSpec/pytest installed, and this project's
 * own "never fabricate a result" convention extends to its own test
 * suite: a missing toolchain should skip with a clear reason, not report
 * a confusing false failure.
 */
function commandExists(cmd: string, versionArgs: string[] = ["--version"]): boolean {
  const result = spawn.sync(cmd, versionArgs, { stdio: "ignore" });
  return !result.error && result.status !== null;
}

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

  it("detects Node's built-in test runner from a `node --test` script", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));

    const result = detectTestCommand(root);
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("node-test");
  });

  it("detects `node --test` even with extra flags/paths around it", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "node --experimental-test-coverage --test test/**/*.js" } })
    );

    const result = detectTestCommand(root);
    expect(result.framework).toBe("node-test");
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

  it("detects Go from go.mod (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "go.mod", "module example.com/foo\n\ngo 1.22\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "go-test", command: "go", args: ["test", "-v", "./..."] });
  });

  it("detects .NET from a .csproj file (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "MyApp.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "dotnet-test", command: "dotnet", args: ["test"] });
  });

  it("detects .NET from a .sln file (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "MySolution.sln", "Microsoft Visual Studio Solution File\n");

    const result = detectTestCommand(root);
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("dotnet-test");
  });

  it("detects RSpec via a Gemfile that declares it (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rspec'\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "rspec", command: "bundle", args: ["exec", "rspec"] });
  });

  it("detects RSpec from a spec/ directory even without a Gemfile (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "spec/foo_spec.rb", "RSpec.describe 'Foo' do; end\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "rspec", command: "rspec", args: [] });
  });

  it("detects pytest from pytest.ini (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "pytest.ini", "[pytest]\n");
    writeFile(root, "test_foo.py", "def test_ok():\n    assert True\n");

    const result = detectTestCommand(root);
    expect(result).toEqual({ supported: true, framework: "pytest", command: "pytest", args: ["-q"] });
  });

  it("detects pytest declared in requirements.txt (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "requirements.txt", "pytest==8.0.0\nrequests\n");

    const result = detectTestCommand(root);
    expect(result.supported).toBe(true);
    expect(result.framework).toBe("pytest");
  });

  it("does not misclassify a bare Python file (no pytest signal) as pytest-testable (Task #89)", () => {
    root = makeTempRepo();
    writeFile(root, "app.py", "print('hi')\n");

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

describe("parseNodeTestOutput", () => {
  it("parses a real `node --test` TAP summary block (captured from a real run)", () => {
    // Captured verbatim from a real `node --test` invocation against a
    // 3-test file (2 passing, 1 failing) — not hand-written from memory.
    const output = [
      "1..3",
      "# tests 3",
      "# suites 0",
      "# pass 2",
      "# fail 1",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 192.178393",
      "",
    ].join("\n");
    expect(parseNodeTestOutput(output)).toEqual({ passed: 2, failed: 1, skipped: 0 });
  });

  it("counts cancelled tests as failed", () => {
    const output = ["# pass 4", "# fail 0", "# cancelled 1", "# skipped 0"].join("\n");
    expect(parseNodeTestOutput(output)).toEqual({ passed: 4, failed: 1, skipped: 0 });
  });

  it("returns null counts when no summary block is found", () => {
    expect(parseNodeTestOutput("some unrelated output\n")).toEqual({
      passed: null,
      failed: null,
      skipped: null,
    });
  });
});

describe("parsePytestOutput", () => {
  it("parses an all-passing summary", () => {
    expect(parsePytestOutput("5 passed in 0.12s\n")).toEqual({ passed: 5, failed: 0, skipped: 0 });
  });

  it("parses failures alongside passes", () => {
    expect(parsePytestOutput("3 failed, 5 passed in 0.34s\n")).toEqual({ passed: 5, failed: 3, skipped: 0 });
  });

  it("parses failures, passes, and skips together", () => {
    expect(parsePytestOutput("1 failed, 2 passed, 1 skipped in 0.10s\n")).toEqual({
      passed: 2,
      failed: 1,
      skipped: 1,
    });
  });

  it("counts errors as failed", () => {
    expect(parsePytestOutput("2 passed, 1 error in 0.05s\n")).toEqual({ passed: 2, failed: 1, skipped: 0 });
  });

  it("returns null counts when no summary is found", () => {
    expect(parsePytestOutput("some unrelated output\n")).toEqual({ passed: null, failed: null, skipped: null });
  });
});

describe("parseRspecOutput", () => {
  it("parses an all-passing summary", () => {
    expect(parseRspecOutput("10 examples, 0 failures\n")).toEqual({ passed: 10, failed: 0, skipped: 0 });
  });

  it("parses failures alongside pending", () => {
    expect(parseRspecOutput("10 examples, 2 failures, 1 pending\n")).toEqual({
      passed: 7,
      failed: 2,
      skipped: 1,
    });
  });

  it("returns null counts when no summary is found", () => {
    expect(parseRspecOutput("some unrelated output\n")).toEqual({ passed: null, failed: null, skipped: null });
  });
});

describe("parseGoTestOutput", () => {
  it("counts verbose PASS/FAIL/SKIP lines", () => {
    const output = [
      "=== RUN   TestAdd",
      "--- PASS: TestAdd (0.00s)",
      "=== RUN   TestSub",
      "--- FAIL: TestSub (0.00s)",
      "=== RUN   TestSkipMe",
      "--- SKIP: TestSkipMe (0.00s)",
      "FAIL",
    ].join("\n");
    expect(parseGoTestOutput(output)).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });

  it("returns null counts when no verbose test lines are found", () => {
    expect(parseGoTestOutput("some unrelated output\n")).toEqual({ passed: null, failed: null, skipped: null });
  });
});

describe("parseDotnetTestOutput", () => {
  it("parses the new VSTest-style summary line", () => {
    const output = "Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12, Duration: 45 ms\n";
    expect(parseDotnetTestOutput(output)).toEqual({ passed: 12, failed: 0, skipped: 0 });
  });

  it("parses the legacy summary line", () => {
    const output = "Total tests: 12. Passed: 10. Failed: 1. Skipped: 1.\n";
    expect(parseDotnetTestOutput(output)).toEqual({ passed: 10, failed: 1, skipped: 1 });
  });

  it("sums multiple project summaries in a multi-project solution", () => {
    const output = [
      "Failed:     0, Passed:     5, Skipped:     0, Total:     5",
      "Failed:     1, Passed:     7, Skipped:     1, Total:     9",
    ].join("\n");
    expect(parseDotnetTestOutput(output)).toEqual({ passed: 12, failed: 1, skipped: 1 });
  });

  it("returns null counts when no summary is found", () => {
    expect(parseDotnetTestOutput("some unrelated output\n")).toEqual({ passed: null, failed: null, skipped: null });
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

  it(
    "actually runs a passing npm test script and captures stdout + exit code",
    async () => {
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
    },
    // All of these spawn `npm test` for real — on Windows that goes
    // through an extra .cmd/cmd.exe wrapper layer (see run.ts's Windows
    // notes) whose startup cost, especially under load, can exceed
    // Vitest's 5s default even though nothing is actually hung. A real
    // pasted Windows run (2026-08-20) hit this on the node --test
    // variant specifically; the same generous timeout is applied to its
    // siblings here so this doesn't just reappear on a slightly slower
    // machine or a busier CI run.
    20_000
  );

  it(
    "actually runs `node --test` and captures real pass/fail counts, not fabricated zeros",
    async () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "node --test" } })
    );
    writeFile(
      root,
      "sample.test.js",
      [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "test('passes', () => { assert.ok(true); });",
        "test('also passes', () => { assert.ok(true); });",
        "test('fails', () => { assert.ok(false); });",
      ].join("\n")
    );

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.framework).toBe("node-test");
    expect(outcome.exitCode).not.toBe(0); // one real failing test
    expect(outcome.passed).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(outcome.skipped).toBe(0);
    },
    20_000
  );

  it(
    "actually runs a failing npm test script and reports a non-zero exit code",
    async () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.exitCode).toBe(1);
    },
    20_000
  );

  it.skipIf(!commandExists("pytest", ["--version"]))(
    "actually runs pytest and captures real pass/fail counts (Task #89)",
    async () => {
    root = makeTempRepo();
    writeFile(root, "pytest.ini", "[pytest]\n");
    writeFile(
      root,
      "test_sample.py",
      ["def test_pass1():", "    assert True", "", "def test_pass2():", "    assert True", "", "def test_fail():", "    assert False", ""].join(
        "\n"
      )
    );

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.framework).toBe("pytest");
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.passed).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(outcome.skipped).toBe(0);
    },
    // pytest's interpreter/import startup can legitimately take longer
    // than Vitest's 5s default on some machines (observed on a real
    // Windows run) — this is a real subprocess doing real work, not a
    // hang, so it gets the same generous per-test timeout as the other
    // "actually runs <toolchain>" tests below rather than a fabricated
    // pass from a lucky-fast machine.
    20_000
  );

  it.skipIf(!commandExists("go", ["version"]))(
    "actually runs `go test -v` and captures real pass/fail counts (Task #89)",
    async () => {
    root = makeTempRepo();
    writeFile(root, "go.mod", "module example.com/ce-testrunner-fixture\n\ngo 1.22\n");
    writeFile(
      root,
      "main_test.go",
      ["package main", "", "import \"testing\"", "", "func TestPass(t *testing.T) {}", "", "func TestFail(t *testing.T) {", "\tt.Fail()", "}", ""].join(
        "\n"
      )
    );

    const outcome = await runTests(root);
    expect(outcome.supported).toBe(true);
    expect(outcome.framework).toBe("go-test");
    expect(outcome.passed).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.skipped).toBe(0);
    },
    20_000
  );

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
