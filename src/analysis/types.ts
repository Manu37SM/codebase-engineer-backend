export type Severity = "critical" | "high" | "medium" | "low";
export type FindingCategory = "maintainability" | "testing" | "security";

export interface Finding {
  /** Stable within a single analysis run — not a DB id (the repo layer assigns those). */
  ruleId: string;
  severity: Severity;
  category: FindingCategory;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** Concrete, real evidence backing this finding — never fabricated. Secrets must be redacted. */
  evidence: string;
  explanation: string;
  recommendation: string;
}

export interface AnalysisFileContext {
  relativePath: string;
  language: string | null;
  loc: number | null;
  isTest: boolean;
  isGenerated: boolean;
  /** Raw text content, or null if the file was too large/binary to read (see fileWalker.MAX_READABLE_FILE_BYTES). */
  text: string | null;
  /** Regex-extracted import specifiers (see indexer/imports.ts) — used by rules that need usage, not just naming. */
  imports: string[];
}

export interface AnalysisContext {
  files: AnalysisFileContext[];
  /** Every relative path in the project, for rules that need to check for a sibling file's existence. */
  allPaths: Set<string>;
}

export interface Rule {
  id: string;
  run(ctx: AnalysisContext): Finding[];
}
