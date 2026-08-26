import path from "node:path";

export interface ImportableFile {
  relativePath: string;
  language: string | null;
  imports: string[];
}

export interface ResolvedEdge {
  fromPath: string;
  toPath: string;
  specifier: string;
}

export interface ImportResolutionResult {

  edges: ResolvedEdge[];

  externalReferences: Map<string, number>;
}

const JS_RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

export function resolveImports(files: ImportableFile[]): ImportResolutionResult {
  const byPath = new Map(files.map((f) => [f.relativePath, f]));
  const javaByBasename = buildJavaBasenameIndex(files);

  const edges: ResolvedEdge[] = [];
  const externalReferences = new Map<string, number>();

  for (const file of files) {
    for (const specifier of file.imports) {
      const resolved =
        file.language === "Java"
          ? resolveJavaImport(specifier, javaByBasename)
          : resolveJsImport(file.relativePath, specifier, byPath);

      if (resolved) {
        edges.push({ fromPath: file.relativePath, toPath: resolved, specifier });
      } else {
        externalReferences.set(specifier, (externalReferences.get(specifier) ?? 0) + 1);
      }
    }
  }

  return { edges, externalReferences };
}

function resolveJsImport(
  fromRelPath: string,
  specifier: string,
  byPath: Map<string, ImportableFile>
): string | null {
  if (!specifier.startsWith(".")) return null; 

  const fromDir = path.posix.dirname(fromRelPath);
  const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));

  const base = resolved.replace(/\.(m|c)?jsx?$/, "");

  for (const ext of JS_RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (byPath.has(candidate)) return candidate;
  }
  return null;
}

function buildJavaBasenameIndex(files: ImportableFile[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!file.relativePath.endsWith(".java")) continue;
    const basename = path.posix.basename(file.relativePath);
    const list = index.get(basename) ?? [];
    list.push(file.relativePath);
    index.set(basename, list);
  }
  return index;
}

function resolveJavaImport(specifier: string, javaByBasename: Map<string, string[]>): string | null {
  if (specifier.endsWith(".*")) return null; 

  const segments = specifier.split(".");
  const className = segments[segments.length - 1];
  const basename = `${className}.java`;
  const candidates = javaByBasename.get(basename);
  if (!candidates || candidates.length === 0) return null;

  const suffix = `${segments.join("/")}.java`;
  const match = candidates.find((c) => c.endsWith(suffix));
  return match ?? null;
}
