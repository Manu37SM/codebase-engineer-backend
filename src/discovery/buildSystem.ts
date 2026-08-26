import fs from "node:fs";
import path from "node:path";

export interface BuildSystemDetectionResult {

  buildSystems: string[];

  dependencyManifests: string[];
}

interface ManifestRule {
  file: string;
  buildSystem: string;
}

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
