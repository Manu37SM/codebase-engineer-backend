import fs from "node:fs";
import path from "node:path";
import type { DependencyInfo } from "./types.js";

/**
 * Regex-based extraction of `<dependency>` blocks from pom.xml — same
 * documented tradeoff as the rest of this product's regex-based parsing
 * (import extraction, framework detection): no real XML/POM object model,
 * so a handful of edge cases aren't distinguished:
 *   - Entries inside `<dependencyManagement>` (version pins for children,
 *     not necessarily used directly by this module) are extracted the same
 *     as ordinary direct dependencies.
 *   - A `<version>` that's a Maven property placeholder (e.g.
 *     `${spring.version}`) is reported as that literal placeholder text,
 *     not resolved to its actual value.
 * Both are called out here rather than silently producing a falsely
 * precise-looking result.
 */
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
    if (!groupId || !artifactId) continue; // malformed/incomplete entry — don't fabricate a name

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
