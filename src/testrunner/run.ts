import spawn from "cross-spawn";
import { detectTestCommand, type TestCommandDetection } from "./detect.js";
import { parseVitestOutput, parseMavenOutput, parseNodeTestOutput, type TestCounts } from "./parse.js";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5MB captured stdout/stderr cap
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — tests can legitimately be slow

// How long to wait, after killing the process tree on timeout, for the
// child's real `close` event before giving up on it and resolving anyway.
// See the Windows round-2 note on `runTests` above for why this exists.
const POST_KILL_GRACE_MS = 2000;

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
 * `cross-spawn` with an argument array — never a shell string, so nothing
 * in a project's config can inject an additional command. `cross-spawn` is
 * used instead of `node:child_process`'s bare `spawn` because on Windows,
 * package-manager commands like `npm`/`pnpm`/`yarn` are `.cmd` batch-file
 * wrappers, and Node's own `spawn` cannot invoke those directly without
 * `shell: true` — which `cross-spawn` handles internally with proper
 * per-argument quoting (not a shell string built by this code), so the
 * "argv array only" security property is preserved on every platform.
 * Always resolves with a result object rather than rejecting on test
 * failure: a failing test suite is expected output, not an exceptional
 * condition; only "we couldn't even attempt to run tests" (unsupported
 * project) is signaled via `supported: false`.
 *
 * Spawns the child in its own process group on POSIX (`detached: true`)
 * and, on timeout, kills the whole tree. A test command like `npm run
 * test` spawns a grandchild (the actual test binary); killing only the
 * immediate `npm` process on timeout would leave that grandchild running,
 * detached from anything that could stop it — a real resource leak for a
 * feature whose entire job is running another repository's own scripts.
 * On POSIX, `detached: true` puts the child in its own process group, so
 * `process.kill(-pid)` kills the whole group.
 *
 * On Windows, `detached` is deliberately left `false`. Windows has no
 * equivalent to POSIX process groups — `detached` there only means "not
 * tied to the parent's console" — so it buys nothing for tree-killing
 * (that's handled instead via `taskkill /pid <pid> /t /f`, which walks the
 * real OS-tracked process tree directly and doesn't need `detached` at
 * all). Worse, `detached: true` combined with piped stdio
 * (`stdio: ["ignore","pipe","pipe"]`) is a known problem on Windows when
 * the resolved command is invoked through a `.cmd`/shell wrapper — which
 * is exactly what `cross-spawn` does internally for `npm`/`pnpm`/`yarn` on
 * Windows: real testing surfaced this as empty captured stdout and
 * processes that never emit a `close` event, hanging until the test's own
 * timeout and then leaving a file lock behind. Leaving `detached: false`
 * on Windows avoids that footgun with no loss of tree-kill capability.
 *
 * Windows round 2 (confirmed by a real pasted Windows `npm test` run,
 * 2026-08-19): even with `detached: false`, `taskkill /pid <pid> /t /f`
 * does not reliably make the child's `close` event fire. `cross-spawn`
 * invokes `npm`/`pnpm`/`yarn` on Windows through a `.cmd` wrapper, which
 * itself goes through an extra `cmd.exe` layer; grandchild processes
 * (the actual test binary, e.g. `node.exe`) can end up holding duplicate
 * handles to the piped stdout/stderr streams. `taskkill /t` kills every
 * process in the tree, but Node's `close` event waits for the stdio
 * streams themselves to end, which depends on every handle to them being
 * released — if any killed process's handle doesn't get cleaned up
 * immediately by the OS, `close` can be delayed indefinitely, hanging
 * this function past its own `timeoutMs` forever (observed as the whole
 * test hanging until Vitest's own unrelated 10s per-test timeout, not
 * this function's 300ms `timeoutMs`). Since the entire point of
 * `timeoutMs` is to bound how long a caller waits, a bounded grace period
 * (`POST_KILL_GRACE_MS`) is applied after `killProcessTree`: if `close`
 * still hasn't fired by then, this function force-resolves with
 * `timedOut: true` and whatever output was captured, rather than waiting
 * on an OS event that may never come. This changes nothing on the (POSIX)
 * path where `close` already fires promptly after `SIGTERM` to the
 * process group — the grace timer is cleared by the normal `finish()`
 * call before it would ever fire there.
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
      // POSIX: own process group, so the whole tree can be killed on
      // timeout via a negative PID. Windows: left false — taskkill
      // handles tree-killing without it, and detached+piped-stdio through
      // a .cmd wrapper is known to break stdio capture/close on Windows.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
      // See the Windows round-2 note on runTests: `close` isn't guaranteed
      // to fire promptly (or at all) after killing the tree on Windows.
      // Give it a bounded grace period, then resolve anyway rather than
      // hanging indefinitely — the caller asked for a bounded wait.
      graceTimer = setTimeout(() => finish(null), POST_KILL_GRACE_MS);
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
      if (graceTimer) clearTimeout(graceTimer);
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

/**
 * Kills a spawned test command and any real descendants it spawned
 * (e.g. the actual test binary launched by `npm run test`), platform-
 * appropriately. POSIX: the child was spawned with `detached: true`, which
 * puts it in its own process group, so a negative PID targets the whole
 * group. Windows: process groups in the POSIX sense don't exist, so
 * `process.kill(-pid)` would just fail; `taskkill /pid <pid> /t /f` is the
 * platform's real tree-kill primitive (`/t` = kill the tree, `/f` =
 * force). `taskkill` itself is invoked via `cross-spawn` with an argv
 * array, not a shell string, consistent with this file's and the rest of
 * the codebase's subprocess-invocation convention.
 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn.sync("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // best-effort — nothing more we can do if taskkill itself fails
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // process (group) already gone — nothing to clean up
  }
}

function parseCounts(framework: string | null, combinedOutput: string): TestCounts {
  if (framework === "vitest") return parseVitestOutput(combinedOutput);
  if (framework === "maven") return parseMavenOutput(combinedOutput);
  if (framework === "node-test") return parseNodeTestOutput(combinedOutput);
  return { passed: null, failed: null, skipped: null }; // unknown format — don't fabricate
}
