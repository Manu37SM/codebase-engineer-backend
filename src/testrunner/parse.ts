export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

const NO_COUNTS: TestCounts = { passed: null, failed: null, skipped: null };

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

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

export function parsePytestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const passed = matchCount(output, "passed");
  const failed = matchCount(output, "failed");
  const errors = matchCount(output, "errors?");
  const skipped = matchCount(output, "skipped");

  if (passed === null && failed === null && errors === null && skipped === null) return NO_COUNTS;
  return { passed: passed ?? 0, failed: (failed ?? 0) + (errors ?? 0), skipped: skipped ?? 0 };
}

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

export function parseGoTestOutput(rawOutput: string): TestCounts {
  const output = stripAnsi(rawOutput);
  const passed = countMatches(output, /^\s*--- PASS: /gm);
  const failed = countMatches(output, /^\s*--- FAIL: /gm);
  const skipped = countMatches(output, /^\s*--- SKIP: /gm);

  if (passed === 0 && failed === 0 && skipped === 0) return NO_COUNTS;
  return { passed, failed, skipped };
}

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
