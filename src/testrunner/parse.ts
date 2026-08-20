export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

const NO_COUNTS: TestCounts = { passed: null, failed: null, skipped: null };

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Strips ANSI color/style escape codes. Vitest's default reporter colors
 * its summary lines (e.g. the "Tests" label itself is wrapped in a dim
 * code), which silently broke the original version of `parseVitestOutput`
 * — a line-start regex anchored on "Tests" never matched because the line
 * actually started with an escape sequence. Caught by dogfooding this
 * parser against this project's own `npm test` output, not just a
 * hand-written fixture string.
 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * Parses Vitest's default text-reporter summary, e.g.:
 *   " Test Files  1 failed | 5 passed (6)"
 *   "      Tests  1 failed | 21 passed (22)"
 * We read the "Tests" line specifically (not "Test Files") since that's the
 * individual-test count, not the file count. Returns null counts (not zeros)
 * when the expected summary line isn't found — a missing line means "we
 * don't actually know", which is a different, more honest, fact than "zero
 * tests ran".
 */
export function parseVitestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const line = output.split("\n").find((l) => /^\s*Tests\s+/.test(l));
  if (!line) return NO_COUNTS;

  const passed = matchCount(line, "passed");
  const failed = matchCount(line, "failed");
  const skipped = matchCount(line, "skipped");

  if (passed === null && failed === null && skipped === null) return NO_COUNTS;
  return { passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0 };
}

/**
 * Parses Maven Surefire's aggregate summary line, e.g.:
 *   "Tests run: 12, Failures: 1, Errors: 0, Skipped: 2"
 * Surefire prints one such line per module plus a final total; we sum every
 * occurrence found (safe for both single-module and multi-module repos —
 * intermediate per-module lines are a subset of, not a duplicate of, useful
 * signal, and Maven doesn't print a distinct grand-total line in `-q` mode).
 * "Errors" are counted as failures — both mean the test did not pass.
 */
export function parseMavenOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const pattern = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g;
  let match: RegExpExecArray | null;
  let totalRun = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  let found = false;

  while ((match = pattern.exec(output)) !== null) {
    found = true;
    totalRun += Number(match[1]);
    totalFailures += Number(match[2]);
    totalErrors += Number(match[3]);
    totalSkipped += Number(match[4]);
  }

  if (!found) return NO_COUNTS;

  const failed = totalFailures + totalErrors;
  const passed = totalRun - failed - totalSkipped;
  return { passed: Math.max(passed, 0), failed, skipped: totalSkipped };
}

function matchCount(line: string, label: string): number | null {
  const match = line.match(new RegExp(`(\\d+)\\s+${label}\\b`));
  return match ? Number(match[1]) : null;
}

/**
 * Parses Node's built-in test runner's (`node --test`) TAP-diagnostic
 * summary, printed at the end of a run regardless of reporter, e.g.:
 *   # tests 5
 *   # suites 0
 *   # pass 4
 *   # fail 1
 *   # cancelled 0
 *   # skipped 0
 *   # todo 0
 *   # duration_ms 12.345
 * "cancelled" tests (e.g. ones that hit a timeout) are counted as failed —
 * a cancelled test did not pass, the same treatment Maven's Surefire
 * parser above gives "Errors". Returns null counts (not zeros) when the
 * summary block isn't found — same "unknown, not zero" contract as the
 * other two parsers.
 */
export function parseNodeTestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const pass = matchTapCount(output, "pass");
  const fail = matchTapCount(output, "fail");
  const cancelled = matchTapCount(output, "cancelled");
  const skipped = matchTapCount(output, "skipped");

  if (pass === null && fail === null && cancelled === null && skipped === null) return NO_COUNTS;
  return {
    passed: pass ?? 0,
    failed: (fail ?? 0) + (cancelled ?? 0),
    skipped: skipped ?? 0,
  };
}

function matchTapCount(output: string, label: string): number | null {
  const match = output.match(new RegExp(`^#\\s*${label}\\s+(\\d+)\\s*$`, "m"));
  return match ? Number(match[1]) : null;
}

/**
 * Parses pytest's final one-line summary, e.g.:
 *   "5 passed in 0.12s"
 *   "3 failed, 5 passed in 0.34s"
 *   "1 failed, 2 passed, 1 skipped in 0.10s"
 *   "2 passed, 1 error in 0.05s"
 * Errors (collection/fixture errors, not assertion failures) are counted
 * as failed — same "didn't pass" treatment Maven's Surefire parser gives
 * its own "Errors" count.
 */
export function parsePytestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const passed = matchCount(output, "passed");
  const failed = matchCount(output, "failed");
  const errors = matchCount(output, "errors?");
  const skipped = matchCount(output, "skipped");

  if (passed === null && failed === null && errors === null && skipped === null) return NO_COUNTS;
  return { passed: passed ?? 0, failed: (failed ?? 0) + (errors ?? 0), skipped: skipped ?? 0 };
}

/**
 * Parses RSpec's default summary line, e.g.:
 *   "10 examples, 2 failures"
 *   "10 examples, 2 failures, 1 pending"
 * "pending" (RSpec's skip mechanism) is reported as skipped.
 */
export function parseRspecOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const match = output.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending)?/);
  if (!match) return NO_COUNTS;

  const examples = Number(match[1]);
  const failures = Number(match[2]);
  const pending = match[3] ? Number(match[3]) : 0;
  const passed = Math.max(examples - failures - pending, 0);
  return { passed, failed: failures, skipped: pending };
}

/**
 * Parses `go test -v ./...` output by counting individual `--- PASS:` /
 * `--- FAIL:` / `--- SKIP:` lines (one per test function) — `go test`'s
 * non-verbose mode only prints a per-package ok/FAIL line, with no
 * individual test counts, so this framework is always invoked with `-v`
 * (see detect.ts) specifically so this parser has something to count.
 */
export function parseGoTestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const passed = countMatches(output, /^\s*--- PASS: /gm);
  const failed = countMatches(output, /^\s*--- FAIL: /gm);
  const skipped = countMatches(output, /^\s*--- SKIP: /gm);

  if (passed === 0 && failed === 0 && skipped === 0) return NO_COUNTS;
  return { passed, failed, skipped };
}

/**
 * Parses `dotnet test` output, which has two summary formats depending on
 * SDK version:
 *   New (VSTest): "Failed:     0, Passed:    12, Skipped:     0, Total:    12"
 *   Old (legacy): "Total tests: 12. Passed: 12. Failed: 0. Skipped: 0."
 * Sums across multiple test project summaries, same reasoning as Maven's
 * multi-module sum: `dotnet test` on a solution runs every test project
 * and prints one summary line per project, with no separate grand total.
 */
export function parseDotnetTestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);

  const newFormat = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/g;
  const oldFormat = /Total tests:\s*(\d+)\.\s*Passed:\s*(\d+)\.\s*Failed:\s*(\d+)\.\s*Skipped:\s*(\d+)\./g;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let found = false;

  let match: RegExpExecArray | null;
  while ((match = newFormat.exec(output)) !== null) {
    found = true;
    failed += Number(match[1]);
    passed += Number(match[2]);
    skipped += Number(match[3]);
  }
  if (!found) {
    while ((match = oldFormat.exec(output)) !== null) {
      found = true;
      passed += Number(match[2]);
      failed += Number(match[3]);
      skipped += Number(match[4]);
    }
  }

  if (!found) return NO_COUNTS;
  return { passed, failed, skipped };
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}
