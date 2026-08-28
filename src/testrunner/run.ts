import spawn from "cross-spawn";
import { detectTestCommand, type TestCommandDetection } from "./detect.js";
import {
  parseVitestOutput,
  parseMavenOutput,
  parseNodeTestOutput,
  parsePytestOutput,
  parseRspecOutput,
  parseGoTestOutput,
  parseDotnetTestOutput,
  type TestCounts,
} from "./parse.js";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; 
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; 

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
      env: { ...process.env, CI: "true" }, 

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

    child.on("error", (err: NodeJS.ErrnoException) => {

      stderr +=
        `\n[codebase-engineer] Could not start the test command "${[detection.command, ...detection.args].join(" ")}": ${err.message}\n` +
        `This almost always means the "${detection.command}" runtime isn't installed in this container image. ` +
        `See deploy/Dockerfile for which test frameworks the image ships with, and extend it for others.`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn.sync("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {

    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {

  }
}

function parseCounts(framework: string | null, combinedOutput: string): TestCounts {
  if (framework === "vitest") return parseVitestOutput(combinedOutput);
  if (framework === "maven") return parseMavenOutput(combinedOutput);
  if (framework === "node-test") return parseNodeTestOutput(combinedOutput);
  if (framework === "pytest") return parsePytestOutput(combinedOutput);
  if (framework === "rspec") return parseRspecOutput(combinedOutput);
  if (framework === "go-test") return parseGoTestOutput(combinedOutput);
  if (framework === "dotnet-test") return parseDotnetTestOutput(combinedOutput);
  return { passed: null, failed: null, skipped: null }; 
}
