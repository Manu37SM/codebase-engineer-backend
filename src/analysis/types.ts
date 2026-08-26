export type Severity = "critical" | "high" | "medium" | "low";
export type FindingCategory = "maintainability" | "testing" | "security" | "documentation" | "dependencies";

export interface Finding {

  ruleId: string;
  severity: Severity;
  category: FindingCategory;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;

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

  text: string | null;

  imports: string[];
}

export interface AnalysisContext {
  files: AnalysisFileContext[];

  allPaths: Set<string>;
}

export interface Rule {
  id: string;
  run(ctx: AnalysisContext): Finding[];
}
