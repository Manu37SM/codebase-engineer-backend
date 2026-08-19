import type { AuditReport } from "./types.js";

/**
 * Renders an `AuditReport` as a standalone Markdown document — the
 * exportable form of the same data the Audit page shows. Evidence strings
 * are included as-is: every rule that produces a Finding is required to
 * redact secrets before the finding ever reaches this layer (see
 * `docs/SECURITY.md`), so nothing here re-checks or re-redacts.
 */
export function buildAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# Audit Report — ${report.project.name}`);
  push();
  push(`- Repository: \`${report.project.rootPath}\``);
  push(`- Generated: ${report.generatedAt}`);
  push();

  push(`## Repository snapshot`);
  push();
  if (!report.snapshot) {
    push("Not yet scanned — no discovery/index snapshot exists for this project.");
  } else {
    const s = report.snapshot;
    push(`- Languages: ${s.languages.map((l) => `${l.language} (${l.fileCount} files)`).join(", ") || "none detected"}`);
    push(`- Frameworks: ${s.frameworks.join(", ") || "none detected"}`);
    push(`- Build system: ${s.buildSystems.join(", ") || "none detected"}`);
    push(`- Package managers: ${s.packageManagers.join(", ") || "none detected"}`);
    push(`- Total files: ${s.totalFiles} (${s.testFiles} test files)`);
    push(`- Last scanned: ${s.indexedAt}`);
  }
  push();

  push(`## Static analysis findings`);
  push();
  if (!report.findings.latestRun) {
    push("No analysis run has been recorded for this project yet.");
  } else {
    push(`Last run: ${report.findings.latestRun.started_at} (status: ${report.findings.latestRun.status})`);
    push();
    push(`- Total findings: ${report.findings.counts.total}`);
    push(`- By severity: ${formatCounts(report.findings.counts.bySeverity)}`);
    push(`- By category: ${formatCounts(report.findings.counts.byCategory)}`);
  }
  push();

  push(`## Security scan (live)`);
  push();
  push(`Scanned: ${report.security.scannedAt}`);
  push();
  if (report.security.findings.length === 0) {
    push("No security findings.");
    push();
  } else {
    for (const f of report.security.findings) {
      push(`### [${f.severity}] ${f.ruleId} — ${f.filePath}${f.lineStart ? `:${f.lineStart}` : ""}`);
      push();
      push(f.explanation);
      push();
      push("```");
      push(f.evidence);
      push("```");
      push();
      push(`Recommendation: ${f.recommendation}`);
      push();
    }
  }

  push(`## Dependencies`);
  push();
  if (report.dependencies.ecosystem === null) {
    push(report.dependencies.duplicatesNote ?? "No supported manifest found.");
  } else {
    push(`Ecosystem: ${report.dependencies.ecosystem}`);
    push(`Direct dependencies: ${report.dependencies.totalDirect}`);
    if (report.dependencies.duplicates.length > 0) {
      push();
      push(`Duplicate versions (${report.dependencies.duplicates.length}):`);
      for (const dup of report.dependencies.duplicates) {
        push(`- ${dup.name}: ${dup.versions.join(", ")}`);
      }
    } else if (report.dependencies.duplicatesNote) {
      push(report.dependencies.duplicatesNote);
    }
  }
  push();

  push(`## Git activity`);
  push();
  if (!report.git.isGitRepository) {
    push("Not a Git repository.");
  } else {
    push(`- Branch: ${report.git.branch ?? "—"}`);
    if (report.git.workingTreeStatus) {
      const wt = report.git.workingTreeStatus;
      push(
        `- Working tree: ${wt.clean ? "clean" : `${wt.modified} modified, ${wt.staged} staged, ${wt.untracked} untracked`}`
      );
    }
    if (report.git.uncommittedChanges) {
      const u = report.git.uncommittedChanges;
      push(`- Uncommitted changes: ${u.filesChanged} file(s), +${u.insertions}/-${u.deletions}`);
    }
    push(`- Recent commits: ${report.git.recentCommits.length}`);
    push(`- Most-churned files (last ${report.git.churnWindowDays} days): ${report.git.fileChurn.length}`);
  }
  push();

  push(`## Tests`);
  push();
  if (!report.latestTestRun) {
    push("No test run has been recorded for this project yet.");
  } else {
    const t = report.latestTestRun;
    push(`- Status: ${t.status}${t.reason ? ` (${t.reason})` : ""}`);
    push(`- Framework: ${t.framework ?? "unknown"}`);
    push(`- Passed: ${t.passed ?? "unknown"}, Failed: ${t.failed ?? "unknown"}, Skipped: ${t.skipped ?? "unknown"}`);
    push(`- Run at: ${t.started_at}`);
  }
  push();

  return lines.join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}
