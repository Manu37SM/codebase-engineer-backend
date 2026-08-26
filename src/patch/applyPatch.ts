import { execFileSync } from "node:child_process";

export interface ApplyPatchResult {
  success: boolean;

  error: string | null;
}

const MAX_ERROR_LENGTH = 4000;

export function applyPatchToDisk(projectRoot: string, diffText: string): ApplyPatchResult {
  const dryRun = runGitApply(projectRoot, diffText, true);
  if (!dryRun.success) return dryRun;

  return runGitApply(projectRoot, diffText, false);
}

function runGitApply(projectRoot: string, diffText: string, dryRun: boolean): ApplyPatchResult {

  const configArgs = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
  const args = dryRun
    ? [...configArgs, "apply", "--check", "-"]
    : [...configArgs, "apply", "-"];
  try {
    execFileSync("git", args, {
      cwd: projectRoot,
      input: diffText,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, error: null };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    let message = stderr.trim() || (err instanceof Error ? err.message : "git apply failed");

    if (message.includes("No valid patches in input")) {
      message += " This usually means the AI's response for this patch wasn't a real diff (see the raw text shown for it) — reject it and try regenerating, possibly with a different provider.";
    }
    return { success: false, error: message.slice(0, MAX_ERROR_LENGTH) };
  }
}
