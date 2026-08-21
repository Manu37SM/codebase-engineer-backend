import { execFileSync } from "node:child_process";

export interface ApplyPatchResult {
  success: boolean;
  /** Real `git apply` stderr on failure (dry-run or real), trimmed and length-capped. Null on success. */
  error: string | null;
}

const MAX_ERROR_LENGTH = 4000;

/**
 * Phase 18: the first place in this product that actually writes to a file
 * on disk. Deliberately narrow: it does exactly one thing, applying an
 * already-approved unified diff to the project's working tree via the
 * real `git apply` — never a hand-rolled patch parser, never a shell
 * string (argv array only, same `execFileSync` convention as
 * `backend/src/git/*.ts`), and never anything beyond what `git apply`
 * itself does.
 *
 * Two-step, both against the real repo: `git apply --check` first (a real
 * dry run — this is the validation Phase 17 explicitly deferred, since a
 * diff a model returns is not guaranteed to still apply cleanly against
 * the current working tree, e.g. if the file changed since the diff was
 * generated) and only if that succeeds, the real `git apply`. If the
 * dry-run fails, nothing is written — the real apply step is never
 * reached. Both steps pipe the diff text via stdin (`-` as an explicit
 * "read the patch from stdin" argument to `git apply`) rather than
 * writing the diff to a temp file, so nothing extra is left behind.
 */
export function applyPatchToDisk(projectRoot: string, diffText: string): ApplyPatchResult {
  const dryRun = runGitApply(projectRoot, diffText, true);
  if (!dryRun.success) return dryRun;

  return runGitApply(projectRoot, diffText, false);
}

function runGitApply(projectRoot: string, diffText: string, dryRun: boolean): ApplyPatchResult {
  // `-c core.autocrlf=false -c core.safecrlf=false` overrides the user's
  // global/repo git config for just this invocation. Without this, on a
  // machine where `core.autocrlf=true` (the common Windows Git-for-Windows
  // installer default), `git apply` silently rewrites `\n` to `\r\n` in the
  // file content it writes, so the file on disk no longer matches the diff
  // byte-for-byte and downstream consumers (e.g. an immediately-following
  // AI-generated-test write, or a human diffing again) see unexpected
  // changes. This product always wants the exact bytes the diff specifies,
  // regardless of the host machine's line-ending config, so autocrlf is
  // force-disabled for both the dry-run and the real apply. `safecrlf=false`
  // is disabled alongside it so a mixed-line-ending file can't cause `git
  // apply` to abort — this tool already validates via `--check` first, so a
  // separate safecrlf abort would just be a confusing extra failure mode.
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
    // "No valid patches in input" means git couldn't find anything
    // diff-shaped at all — not "the diff doesn't apply cleanly" (a
    // different failure this same catch also handles). Since diff_text is
    // stored unvalidated straight from the AI's raw response (see
    // generatePatch.ts's doc comment), this almost always means the model
    // responded with prose, an explicit "NO_PATCH: ..." decline, or a diff
    // wrapped in markdown fences instead of a real diff.
    if (message.includes("No valid patches in input")) {
      message += " This usually means the AI's response for this patch wasn't a real diff (see the raw text shown for it) — reject it and try regenerating, possibly with a different provider.";
    }
    return { success: false, error: message.slice(0, MAX_ERROR_LENGTH) };
  }
}
