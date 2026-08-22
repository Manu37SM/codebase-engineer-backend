import type { AnalysisContext, Finding, Rule } from "../types.js";

/**
 * Flags `package.json` dependencies pinned to `"*"` or `"latest"` — the two
 * genuinely unpinned forms npm/pnpm/yarn all accept literally (unlike range
 * specifiers such as `^1.2.3`/`~1.2.3`, which are pinned to a known
 * compatible band and deliberately not flagged here — that's normal semver
 * range usage, not a real gap). A dependency with no floor at all means a
 * fresh install can silently pull in a breaking or compromised release with
 * no warning, in the ordinary course of running `npm install`.
 *
 * Only looks at real, top-level `package.json` files this project's own
 * file walker already indexed (so `node_modules` is excluded the same way
 * every other rule already gets it excluded) — never fetches anything over
 * the network, consistent with this analyzer's fully offline, evidence-only
 * design.
 */
export const unpinnedDependencyRule: Rule = {
  id: "unpinned-dependency",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      if (!file.relativePath.endsWith("package.json") || file.text === null) continue;

      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(file.text);
      } catch {
        continue; // malformed package.json is a different problem, not this rule's concern
      }

      const offenders: string[] = [];
      for (const section of [pkg.dependencies, pkg.devDependencies]) {
        if (!section) continue;
        for (const [name, version] of Object.entries(section)) {
          if (version === "*" || version === "latest") {
            offenders.push(`${name}@${version}`);
          }
        }
      }

      if (offenders.length === 0) continue;

      findings.push({
        ruleId: "unpinned-dependency",
        severity: "medium",
        category: "dependencies",
        filePath: file.relativePath,
        lineStart: null,
        lineEnd: null,
        evidence: `${offenders.length} dependenc${offenders.length === 1 ? "y" : "ies"} with no version floor: ${offenders.join(", ")}`,
        explanation:
          "A dependency pinned to \"*\" or \"latest\" has no version floor — a fresh install can silently pull in a new major release (or a compromised one) with no warning, breaking the build or introducing a vulnerability the next time anyone runs an install.",
        recommendation:
          "Pin each of these to a real version range (e.g. \"^1.2.3\") and commit the lockfile so installs are reproducible.",
      });
    }

    return findings;
  },
};
