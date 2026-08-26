export type DependencyType = "dependency" | "devDependency";

export interface DependencyInfo {
  name: string;
  versionRange: string | null;
  type: DependencyType;
}

export interface DuplicateVersionGroup {
  name: string;
  versions: string[];
}

export interface DependencyAnalysisResult {
  ecosystem: "npm" | "maven" | null;
  direct: DependencyInfo[];
  totalDirect: number;
  duplicates: DuplicateVersionGroup[];

  duplicatesSource: string | null;
  duplicatesNote: string | null;
  analyzedAt: string;
}
