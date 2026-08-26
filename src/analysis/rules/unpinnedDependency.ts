import type { AnalysisContext, Finding, Rule } from "../types.js";

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
        continue; 
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
