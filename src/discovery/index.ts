import { assertValidProjectRoot } from "../security/paths.js";
import { walkRepository } from "./fileWalker.js";
import { detectLanguages, LanguageStat } from "./languages.js";
import { detectBuildSystem } from "./buildSystem.js";
import { detectPackageManagers } from "./packageManager.js";
import { detectFrameworks } from "./frameworks.js";
import { detectGit, WorkingTreeStatus } from "./git.js";

export interface DiscoveryResult {
  root: string;
  isGitRepository: boolean;
  gitBranch: string | null;
  workingTreeStatus: WorkingTreeStatus | null;
  languages: LanguageStat[];
  totalFiles: number;
  otherFiles: number;
  buildSystems: string[];
  packageManagers: string[];
  frameworks: string[];
  dependencyManifests: string[];
  discoveredAt: string;
}

/**
 * Runs full repository discovery against an already-validated project root.
 * Composes the individual detectors (Phase 2 scope: discovery only — full
 * indexing with per-file symbol/import extraction is Phase 3).
 */
export function discoverRepository(root: string): DiscoveryResult {
  assertValidProjectRoot(root);

  const files = walkRepository({ root });
  const languageResult = detectLanguages(files);
  const buildSystemResult = detectBuildSystem(root);
  const packageManagers = detectPackageManagers(root);
  const frameworks = detectFrameworks(root);
  const git = detectGit(root);

  return {
    root,
    isGitRepository: git.isGitRepository,
    gitBranch: git.branch,
    workingTreeStatus: git.workingTreeStatus,
    languages: languageResult.languages,
    totalFiles: languageResult.totalFiles,
    otherFiles: languageResult.otherFiles,
    buildSystems: buildSystemResult.buildSystems,
    packageManagers,
    frameworks,
    dependencyManifests: buildSystemResult.dependencyManifests,
    discoveredAt: new Date().toISOString(),
  };
}
