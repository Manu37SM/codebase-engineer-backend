import { describe, it, expect, afterEach } from "vitest";
import { detectSubProjects } from "../src/discovery/multiProject.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("detectSubProjects (Task #87)", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("reports a single-project folder as not multi-project", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", "{}");
    writeFile(root, "src/index.js", "console.log(1);");

    const result = detectSubProjects(root);
    expect(result.isMultiProject).toBe(false);
    expect(result.candidates).toEqual([{ relativePath: "", markers: ["package.json"] }]);
  });

  it("detects multiple independent projects nested under one folder", () => {
    root = makeTempRepo();
    writeFile(root, "frontend/package.json", "{}");
    writeFile(root, "backend/pyproject.toml", "[tool.poetry]\n");
    writeFile(root, "tools/cli/go.mod", "module cli\n");

    const result = detectSubProjects(root);
    expect(result.isMultiProject).toBe(true);
    const paths = result.candidates.map((c) => c.relativePath).sort();
    expect(paths).toEqual(["backend", "frontend", "tools/cli"]);
  });

  it("ignores marker files inside node_modules and .git", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", "{}");
    writeFile(root, "node_modules/some-dep/package.json", "{}");
    writeFile(root, ".git/hooks/package.json", "{}"); 

    const result = detectSubProjects(root);
    expect(result.isMultiProject).toBe(false);
    expect(result.candidates).toEqual([{ relativePath: "", markers: ["package.json"] }]);
  });

  it("reports both a root marker and a nested marker as multi-project", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", "{}"); 
    writeFile(root, "packages/lib-a/package.json", "{}");

    const result = detectSubProjects(root);
    expect(result.isMultiProject).toBe(true);
    expect(result.candidates[0]).toEqual({ relativePath: "", markers: ["package.json"] }); 
    expect(result.candidates.some((c) => c.relativePath === "packages/lib-a")).toBe(true);
  });

  it("reports no candidates for a folder with no recognized marker files", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "# hello\n");

    const result = detectSubProjects(root);
    expect(result.isMultiProject).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});
