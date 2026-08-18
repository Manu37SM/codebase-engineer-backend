import { assertValidProjectRoot } from "../security/paths.js";
import { walkRepository, readTextFileSafe } from "../discovery/fileWalker.js";
import { languageForPath } from "../discovery/languages.js";
import { isTestFile, isGeneratedFile } from "../indexer/classify.js";
import { extractImports } from "../indexer/imports.js";
import type { AnalysisContext, AnalysisFileContext } from "./types.js";

/**
 * Builds the analysis rules' input by walking the repository fresh off
 * disk. Rules need raw text (for line-level evidence like large functions
 * or TODO counts), which the persisted `file` index doesn't store — so
 * analysis re-walks rather than reading from the Phase 3 index. This keeps
 * findings evidence traceable to the actual current file content, not a
 * potentially-stale index.
 */
export function buildAnalysisContext(root: string): AnalysisContext {
  assertValidProjectRoot(root);

  const walked = walkRepository({ root });
  const allPaths = new Set(walked.map((f) => f.relPath));

  const files: AnalysisFileContext[] = walked.map((walkedFile) => {
    const language = languageForPath(walkedFile.relPath);
    const text = readTextFileSafe(walkedFile.absPath, walkedFile.sizeBytes);
    const loc = text !== null ? countLines(text) : null;
    return {
      relativePath: walkedFile.relPath,
      language,
      loc,
      isTest: isTestFile(walkedFile.relPath),
      isGenerated: isGeneratedFile(walkedFile.relPath, text),
      text,
      imports: text !== null ? extractImports(language, text) : [],
    };
  });

  return { files, allPaths };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/\n/g);
  const newlineCount = matches ? matches.length : 0;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}
