export interface ContextItem {
  path: string;
  reason: string;
  tokens: number;

  content?: string;
}

export interface ExcludedItem {
  path: string;
  reason: string;
}

export interface ContextBundle {
  targetId: string;
  budgetTokens: number;
  selected: ContextItem[];
  excluded: ExcludedItem[];
  totalTokens: number;
}

export interface FindingTarget {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface TestFailureTarget {
  id: string;
  command: string | null;
  framework: string | null;
  stdout: string;
  stderr: string;
}

export interface FileForSelection {
  relativePath: string;
  language: string | null;
  imports: string[];
  isTest: boolean;
}
