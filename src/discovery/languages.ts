import { readTextFileSafe, WalkedFile } from "./fileWalker.js";

/**
 * Language support, per docs/PRD.md §3 — started with Java, JavaScript,
 * TypeScript; broadened (Task #89) to cover the other languages the
 * test-runner (backend/src/testrunner/detect.ts) and the rest of the
 * product's docs already promise: Python, Ruby, Go, C#, PHP, C/C++, SQL,
 * Rust, Kotlin, Swift. Other extensions are still counted under "Other" so
 * the dashboard's file totals stay accurate, but they don't get
 * first-class per-language LOC treatment.
 */
export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".pyi": "Python",
  ".pyw": "Python",
  ".rb": "Ruby",
  ".rake": "Ruby",
  ".go": "Go",
  ".cs": "C#",
  ".php": "PHP",
  ".phtml": "PHP",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".hh": "C++",
  ".hxx": "C++",
  ".sql": "SQL",
  ".rs": "Rust",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".swift": "Swift",
};

/** Returns the detected language for a relative path, or null if unrecognized. */
export function languageForPath(relPath: string): string | null {
  const idx = relPath.lastIndexOf(".");
  if (idx === -1) return null;
  const ext = relPath.slice(idx).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

export interface LanguageStat {
  language: string;
  fileCount: number;
  approxLoc: number;
}

export interface LanguageDetectionResult {
  languages: LanguageStat[];
  totalFiles: number;
  otherFiles: number;
}

/**
 * Counts files and approximate lines-of-code per detected language. LOC is
 * "approximate" deliberately: it is a newline count on files under the
 * readable-size cap, not a language-aware parse — good enough for dashboard
 * summaries, not a substitute for the Phase 6 analysis engine.
 */
export function detectLanguages(files: WalkedFile[]): LanguageDetectionResult {
  const byLanguage = new Map<string, { fileCount: number; approxLoc: number }>();
  let otherFiles = 0;

  for (const file of files) {
    const ext = extensionOf(file.relPath);
    const language = EXTENSION_LANGUAGE_MAP[ext];
    if (!language) {
      otherFiles++;
      continue;
    }

    const entry = byLanguage.get(language) ?? { fileCount: 0, approxLoc: 0 };
    entry.fileCount++;

    const text = readTextFileSafe(file.absPath, file.sizeBytes);
    if (text !== null) {
      entry.approxLoc += countLines(text);
    }

    byLanguage.set(language, entry);
  }

  const languages: LanguageStat[] = Array.from(byLanguage.entries())
    .map(([language, stat]) => ({ language, ...stat }))
    .sort((a, b) => b.fileCount - a.fileCount);

  return { languages, totalFiles: files.length, otherFiles };
}

function extensionOf(relPath: string): string {
  const idx = relPath.lastIndexOf(".");
  if (idx === -1) return "";
  return relPath.slice(idx).toLowerCase();
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/\n/g);
  const newlineCount = matches ? matches.length : 0;
  // Count a trailing partial line as a line too.
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}
