import { spawn } from "node:child_process";
import { detectTestCommand, type TestCommandDetection } from "./detect.js";
import { parseVitestOutput, parseMavenOutput, type TestCounts } from "./parse.js";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB captured stdout/stderr cap
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — tests can legitimately be slow

export interface TestRunOutcome {
  supported: boolean;
  reason?: string;
  framework: string | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  timedOut: boolean;
}

/**
 * Runs the project's test command (as chosen by `detectTestCommand`) via
 * `child_process.spawn` with an argument array — never a shell string, so
 * nothing in a project's config can inject an additional command. Always
 * resolves with a result object rather than rejecting on test failure: a
 * failing test suite is expected output, not an exceptional condition; only
 * "we couldn't even attempt to run tests" (unsupported project) is signaled
 * via `supported: false`.
 *
 * Spawns the child in its own process group (`detached: true`) and, on
 * timeout, kills the whole group (`process.kill(-pid)`). A test command
 * like `npm run test` spawns a grandchild (the actual test binary); killing
 * only the immediate `npm` process on timeout would leave that grandchild
 * running, detached from anything that could stop it — a real resource
 * leak for a feature whose entire job is running another repository's own
 * scripts.
 */
export function runTests(
  root: string,
  options: { timeoutMs?: number; detection?: TestCommandDetection } = {}
): Promise<TestRunOutcome> {
  const detection = options.detection ?? detectTestCommand(root);
  if (!detection.supported || !detection.command) {
    return Promise.resolve({
      supported: false,
      reason: detection.reason,
      framework: detection.framework,
      command: null,
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      passed: null,
      failed: null,
      skipped: null,
      timedOut: false,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(detection.command!, detection.args, {
      cwd: root,
      env: { ...process.env, CI: "true" }, // discourage interactive/watch-mode behavior
      detached: true, // own process group, so the whole tree can be killed on timeout
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // process (group) already gone — nothing to clean up
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
    });

    function finish(exitCode: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const combined = `${stdout}\n${stderr}`;
      const counts = parseCounts(detection.framework, combined);

      resolve({
        supported: true,
        framework: detection.framework,
        command: [detection.command, ...detection.args].join(" "),
        exitCode,
        durationMs,
        stdout,
        stderr,
        ...counts,
        timedOut,
      });
    }

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function parseCounts(framework: string | null, combinedOutput: string): TestCounts {
  if (framework === "vitest") return parseVitestOutput(combinedOutput);
  if (framework === "maven") return parseMavenOutput(combinedOutput);
  return { passed: null, failed: null, skipped: null }; // unknown format — don't fabricate
}
