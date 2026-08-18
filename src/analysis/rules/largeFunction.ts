import type { AnalysisContext, Finding, Rule } from "../types.js";

const LINE_THRESHOLD = 60;

// Matches a line that looks like the opening of a function/method body:
// `function foo(...) {`, `public void bar(...) {`, `methodName(...): T {`.
const FUNCTION_SIGNATURE = /^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;{}]*\)\s*(?::\s*[A-Za-z0-9_$<>[\],\s|.]+)?\s*\{\s*$/;

// Matches an arrow function with a block body assigned to a name:
// `const foo = (...) => {` / `export const foo = async (...) => {`.
const ARROW_SIGNATURE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\([^;{}]*\)\s*(?::\s*[^={}]+)?=>\s*\{\s*$/;

/**
 * Flags function/method bodies whose line span crosses a fixed threshold,
 * using a brace-balance scan rather than a real parser. This is a
 * deliberate, documented approximation (see docs/FEATURE.md): it can miss
 * unusual formatting and doesn't account for braces inside strings/comments,
 * but every finding it does produce cites a real signature line and a real
 * measured span — nothing is invented.
 *
 * Applies only to JavaScript/TypeScript/Java, where this pattern is common;
 * skipped entirely for other languages rather than guessing.
 */
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
      continue; // unbalanced — don't guess, just move on
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

    // Skip past this function's body so nested inner functions aren't
    // reported separately from the outer one that already covers them.
    i = endIndex + 1;
  }

  return findings;
}

/**
 * Given the index of a line ending in an opening brace, scans forward
 * tracking brace depth to find the line where it returns to zero. Returns
 * null if the braces never balance before EOF (approximation limitation —
 * e.g. a brace inside a string threw off the count).
 */
function findMatchingBraceEnd(lines: string[], startIndex: number): number | null {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && i > startIndex) return i;
    if (depth === 0 && i === startIndex) return i; // single-line body (rare given the regex requires trailing '{')
  }
  return null;
}
