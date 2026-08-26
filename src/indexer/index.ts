import { assertValidProjectRoot } from "../security/paths.js";
import { walkRepository, readTextFileSafe } from "../discovery/fileWalker.js";
import { languageForPath } from "../discovery/languages.js";
import { isTestFile, isGeneratedFile } from "./classify.js";
import { extractImports } from "./imports.js";
import { computeContentHash } from "./contentHash.js";

export interface IndexedFile {
  relativePath: string;
  language: string | null;
  loc: number | null;
  sizeBytes: number;
  isTest: boolean;
  isGenerated: boolean;
  contentHash: string | null;
  imports: string[];
}

export interface IndexResult {
  root: string;
  files: IndexedFile[];
  totalFiles: number;
  testFiles: number;
  generatedFiles: number;
  indexedAt: string;
}

export function indexRepository(root: string): IndexResult {
  assertValidProjectRoot(root);

  const walked = walkRepository({ root });
  const files: IndexedFile[] = [];
  let testFiles = 0;
  let generatedFiles = 0;

  for (const walkedFile of walked) {
    const language = languageForPath(walkedFile.relPath);
    const text = readTextFileSafe(walkedFile.absPath, walkedFile.sizeBytes);
    const loc = text !== null ? countLines(text) : null;
    const generated = isGeneratedFile(walkedFile.relPath, text);
    const test = isTestFile(walkedFile.relPath);
    const imports = text !== null ? extractImports(language, text) : [];
    const contentHash = computeContentHash(walkedFile.absPath, walkedFile.sizeBytes);

    if (test) testFiles++;
    if (generated) generatedFiles++;

    files.push({
      relativePath: walkedFile.relPath,
      language,
      loc,
      sizeBytes: walkedFile.sizeBytes,
      isTest: test,
      isGenerated: generated,
      contentHash,
      imports,
    });
  }

  return {
    root,
    files,
    totalFiles: files.length,
    testFiles,
    generatedFiles,
    indexedAt: new Date().toISOString(),
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/\n/g);
  const newlineCount = matches ? matches.length : 0;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}
