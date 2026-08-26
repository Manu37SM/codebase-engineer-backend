

const JS_IMPORT_PATTERNS = [
  /import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /export\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /require\(\s*["']([^"']+)["']\s*\)/g,
];

const JAVA_IMPORT_PATTERN = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

export function extractImports(language: string | null, text: string): string[] {
  if (!language) return [];
  if (language === "JavaScript" || language === "TypeScript") {
    return extractWithPatterns(text, JS_IMPORT_PATTERNS);
  }
  if (language === "Java") {
    return extractWithPatterns(text, [JAVA_IMPORT_PATTERN]);
  }
  return [];
}

function extractWithPatterns(text: string, patterns: RegExp[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.add(match[1]);
      if (found.size > 500) break; 
    }
  }
  return Array.from(found).sort();
}
