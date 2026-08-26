import type { AnalysisContext, Finding, Rule } from "../types.js";

const LINE_THRESHOLD = 60;

const FUNCTION_SIGNATURE = /^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;{}]*\)\s*(?::\s*[A-Za-z0-9_$<>[\],\s|.]+)?\s*\{\s*$/;

const ARROW_SIGNATURE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\([^;{}]*\)\s*(?::\s*[^={}]+)?=>\s*\{\s*$/;

export const largeFunctionRule: Rule = {
  id: "large-function",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const file of ctx.files) {
      if (file.text === null || file.isGenerated) continue;
      if (!["JavaScript", "TypeScript", "Java"].includes(file.language ?? "")) continue;

      findings.push(...scanFile(file.relativePath, file.text));
    }
    return findings;
  },
};

function scanFile(relativePath: string, text: string): Finding[] {
  const lines = text.split("\n");
  const findings: Finding[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = FUNCTION_SIGNATURE.exec(line) ?? ARROW_SIGNATURE.exec(line);
    if (!match) {
      i++;
      continue;
    }

    const name = match[1];
    const endIndex = findMatchingBraceEnd(lines, i);
    if (endIndex === null) {
      i++;
      continue; 
    }

    const spanLines = endIndex - i + 1;
    if (spanLines > LINE_THRESHOLD) {
      findings.push({
        ruleId: "large-function",
        severity: spanLines > LINE_THRESHOLD * 2 ? "high" : "medium",
        category: "maintainability",
        filePath: relativePath,
        lineStart: i + 1,
        lineEnd: endIndex + 1,
        evidence: `Function/method '${name}' spans ${spanLines} lines (threshold: ${LINE_THRESHOLD}), starting at line ${i + 1}`,
        explanation:
          "Long functions tend to take on multiple responsibilities, which makes them harder to test and reason about in isolation.",
        recommendation: `Consider extracting parts of '${name}' into smaller, named helper functions.`,
      });
    }

    i = endIndex + 1;
  }

  return findings;
}

function findMatchingBraceEnd(lines: string[], startIndex: number): number | null {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && i > startIndex) return i;
    if (depth === 0 && i === startIndex) return i; 
  }
  return null;
}
