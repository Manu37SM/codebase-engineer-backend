import fs from "node:fs";
import path from "node:path";
import type { DependencyInfo } from "./types.js";

export function parsePomDependencies(root: string): DependencyInfo[] {
  const pomPath = path.join(root, "pom.xml");
  if (!fs.existsSync(pomPath)) return [];

  let xml: string;
  try {
    xml = fs.readFileSync(pomPath, "utf-8");
  } catch {
    return [];
  }

  const dependencies: DependencyInfo[] = [];
  const blockPattern = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(xml)) !== null) {
    const block = match[1];
    const groupId = extractTag(block, "groupId");
    const artifactId = extractTag(block, "artifactId");
    if (!groupId || !artifactId) continue; 

    const version = extractTag(block, "version");
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      versionRange: version,
      type: "dependency",
    });
  }

  return dependencies;
}

function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`).exec(xml);
  return match ? match[1].trim() : null;
}
