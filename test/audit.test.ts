import { describe, it, expect } from "vitest";
import { buildAuditMarkdown } from "../src/audit/markdown.js";
import type { AuditReport } from "../src/audit/types.js";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    project: { id: "p1", name: "my-app", rootPath: "/tmp/my-app" },
    generatedAt: "2026-08-18T00:00:00.000Z",
    snapshot: null,
    findings: {
      latestRun: null,
      counts: { total: 0, bySeverity: {}, byCategory: {} },
    },
    security: { findings: [], scannedAt: "2026-08-18T00:00:00.000Z" },
    dependencies: {
      ecosystem: null,
      direct: [],
      totalDirect: 0,
      duplicates: [],
      duplicatesSource: null,
      duplicatesNote: "No supported manifest found (pom.xml or package.json).",
      analyzedAt: "2026-08-18T00:00:00.000Z",
    },
    git: {
      isGitRepository: false,
      branch: null,
      workingTreeStatus: null,
      recentCommits: [],
      fileChurn: [],
      uncommittedChanges: null,
      churnWindowDays: 90,
      analyzedAt: "2026-08-18T00:00:00.000Z",
    },
    latestTestRun: null,
    ...overrides,
  };
}

describe("buildAuditMarkdown", () => {
  it("honestly reports an unscanned, unanalyzed, untested project", () => {
    const md = buildAuditMarkdown(baseReport());

    expect(md).toContain("# Audit Report — my-app");
    expect(md).toContain("Not yet scanned");
    expect(md).toContain("No analysis run has been recorded");
    expect(md).toContain("No security findings.");
    expect(md).toContain("No supported manifest found");
    expect(md).toContain("Not a Git repository.");
    expect(md).toContain("No test run has been recorded");
  });

  it("renders a fully populated report, including redacted-evidence security findings", () => {
    const report = baseReport({
      snapshot: {
        languages: [{ language: "TypeScript", fileCount: 3, approxLoc: 42 }],
        frameworks: ["React"],
        buildSystems: ["npm"],
        packageManagers: ["npm"],
        totalFiles: 10,
        testFiles: 2,
        indexedAt: "2026-08-18T00:00:00.000Z",
      },
      findings: {
        latestRun: {
          id: "run1",
          project_id: "p1",
          started_at: "2026-08-18T00:00:00.000Z",
          finished_at: "2026-08-18T00:00:01.000Z",
          status: "completed",
          findings_count: 3,
        },
        counts: { total: 3, bySeverity: { high: 1, medium: 2 }, byCategory: { security: 1, maintainability: 2 } },
      },
      security: {
        scannedAt: "2026-08-18T00:00:00.000Z",
        findings: [
          {
            ruleId: "env-file-committed",
            severity: "high",
            category: "security",
            filePath: ".env",
            lineStart: null,
            lineEnd: null,
            evidence: "[REDACTED]",
            explanation: "A .env-style file is committed to the repository.",
            recommendation: "Remove it and rotate any secrets it contained.",
          },
        ],
      },
      dependencies: {
        ecosystem: "npm",
        direct: [{ name: "react", versionRange: "^18.0.0", type: "dependency" }],
        totalDirect: 12,
        duplicates: [{ name: "lodash", versions: ["3.10.1", "4.17.21"] }],
        duplicatesSource: "package-lock.json",
        duplicatesNote: null,
        analyzedAt: "2026-08-18T00:00:00.000Z",
      },
      git: {
        isGitRepository: true,
        branch: "main",
        workingTreeStatus: { modified: 1, staged: 0, untracked: 0, clean: false },
        recentCommits: [
          {
            hash: "a".repeat(40),
            shortHash: "aaaaaaa",
            authorName: "Dev",
            authorEmail: "dev@example.com",
            date: "2026-08-18T00:00:00+00:00",
            message: "fix bug",
          },
        ],
        fileChurn: [{ path: "src/hot.ts", commitCount: 5 }],
        uncommittedChanges: { filesChanged: 1, insertions: 3, deletions: 1, files: [] },
        churnWindowDays: 90,
        analyzedAt: "2026-08-18T00:00:00.000Z",
      },
      latestTestRun: {
        id: "t1",
        project_id: "p1",
        framework: "vitest",
        command: "npm test",
        exit_code: 0,
        duration_ms: 1234,
        passed: 10,
        failed: 0,
        skipped: 1,
        status: "passed",
        reason: null,
        started_at: "2026-08-18T00:00:00.000Z",
      },
    });

    const md = buildAuditMarkdown(report);

    expect(md).toContain("Languages: TypeScript (3 files)");
    expect(md).toContain("Total findings: 3");
    expect(md).toContain("high: 1, medium: 2");
    expect(md).toContain("env-file-committed");
    expect(md).toContain("[REDACTED]");
    expect(md).not.toContain("SECRET=");
    expect(md).toContain("Ecosystem: npm");
    expect(md).toContain("lodash: 3.10.1, 4.17.21");
    expect(md).toContain("Branch: main");
    expect(md).toContain("Passed: 10, Failed: 0, Skipped: 1");
  });
});
