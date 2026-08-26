import path from "node:path";
import { walkRepository } from "./fileWalker.js";

const MARKER_FILE_NAMES = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "*.sln", 
]);

const MAX_CANDIDATES = 100;

function isMarkerFile(fileName: string): string | null {
  if (MARKER_FILE_NAMES.has(fileName)) return fileName;
  if (fileName.endsWith(".csproj")) return "*.csproj";
  if (fileName.endsWith(".sln")) return "*.sln";
  return null;
}

export interface SubProjectCandidate {

  relativePath: string;

  markers: string[];
}

export interface MultiProjectDetectionResult {

  isMultiProject: boolean;

  candidates: SubProjectCandidate[];

  truncated: boolean;
}

export function detectSubProjects(root: string): MultiProjectDetectionResult {
  const files = walkRepository({ root });

  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const fileName = path.posix.basename(file.relPath);
    const marker = isMarkerFile(fileName);
    if (!marker) continue;

    const dir = path.posix.dirname(file.relPath);
    const dirKey = dir === "." ? "" : dir;
    if (!byDir.has(dirKey)) byDir.set(dirKey, new Set());
    byDir.get(dirKey)!.add(marker);
  }

  const allCandidates: SubProjectCandidate[] = Array.from(byDir.entries())
    .map(([relativePath, markers]) => ({ relativePath, markers: Array.from(markers).sort() }))
    .sort((a, b) => {

      if (a.relativePath === "") return -1;
      if (b.relativePath === "") return 1;
      const depthDiff = a.relativePath.split("/").length - b.relativePath.split("/").length;
      if (depthDiff !== 0) return depthDiff;
      return a.relativePath.localeCompare(b.relativePath);
    });

  const truncated = allCandidates.length > MAX_CANDIDATES;
  const candidates = truncated ? allCandidates.slice(0, MAX_CANDIDATES) : allCandidates;

  return {
    isMultiProject: allCandidates.length > 1,
    candidates,
    truncated,
  };
}
