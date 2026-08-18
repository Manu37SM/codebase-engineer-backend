import fs from "node:fs";
import path from "node:path";

export interface BuildSystemDetectionResult {
  /** Detected build systems, e.g. ["maven", "npm"]. May be more than one in a monorepo. */
  buildSystems: string[];
  /** Relative paths to dependency/build manifests found at the repo root. */
  dependencyManifests: string[];
}

interface ManifestRule {
  file: string;
  buildSystem: string;
}

/**
 * Initial strong support per docs/PRD.md §3: Maven and npm-family (npm/pnpm/
 * yarn all use package.json as the build manifest — which package manager is
 * in play is determined separately by packageManager.ts via lockfile).
 * Gradle is detected (so it shows up truthfully in a scan) but is not yet a
 * "supported" build system for test running / dependency analysis — that is
 * tracked as future work in docs/FEATURE.md.
 */
const ROOT_MANIFEST_RULES: ManifestRule[] = [
  { file: "pom.xml", buildSystem: "maven" },
  { file: "package.json", buildSystem: "npm" },
  { file: "build.gradle", buildSystem: "gradle" },
  { file: "build.gradle.kts", buildSystem: "gradle" },
];

export function detectBuildSystem(root: string): BuildSystemDetectionResult {
  const buildSystems = new Set<string>();
  const dependencyManifests: string[] = [];

  for (const rule of ROOT_MANIFEST_RULES) {
    if (fs.existsSync(path.join(root, rule.file))) {
      buildSystems.add(rule.buildSystem);
      dependencyManifests.push(rule.file);
    }
  }

  return {
    buildSystems: Array.from(buildSystems).sort(),
    dependencyManifests,
  };
}
