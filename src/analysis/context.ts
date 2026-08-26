import { assertValidProjectRoot } from "../security/paths.js";
import { walkRepository, readTextFileSafe } from "../discovery/fileWalker.js";
import { languageForPath } from "../discovery/languages.js";
import { isTestFile, isGeneratedFile } from "../indexer/classify.js";
import { extractImports } from "../indexer/imports.js";
import type { AnalysisContext, AnalysisFileContext } from "./types.js";

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
