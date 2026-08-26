import { describe, it, expect } from "vitest";
import { resolveImports } from "../src/architecture/resolveImports.js";
import { buildArchitectureView } from "../src/architecture/aggregate.js";

describe("resolveImports", () => {
  it("resolves relative JS/TS imports to indexed files, with and without extensions", () => {
    const files = [
      { relativePath: "src/a/index.ts", language: "TypeScript", imports: ["./helper", "../b/thing"] },
      { relativePath: "src/a/helper.ts", language: "TypeScript", imports: [] },
      { relativePath: "src/b/thing.ts", language: "TypeScript", imports: [] },
    ];

    const { edges, externalReferences } = resolveImports(files);

    expect(edges).toEqual(
      expect.arrayContaining([
        { fromPath: "src/a/index.ts", toPath: "src/a/helper.ts", specifier: "./helper" },
        { fromPath: "src/a/index.ts", toPath: "src/b/thing.ts", specifier: "../b/thing" },
      ])
    );
    expect(externalReferences.size).toBe(0);
  });

  it("treats a bare specifier as external, not a resolvable edge", () => {
    const files = [{ relativePath: "src/a.ts", language: "TypeScript", imports: ["react", "./missing"] }];
    const { edges, externalReferences } = resolveImports(files);

    expect(edges).toHaveLength(0);
    expect(externalReferences.get("react")).toBe(1);
    expect(externalReferences.get("./missing")).toBe(1); 
  });

  it("resolves a NodeNext-style '.js' specifier to its actual '.ts' source file", () => {

    const files = [
      { relativePath: "src/a.ts", language: "TypeScript", imports: ["./helper.js"] },
      { relativePath: "src/helper.ts", language: "TypeScript", imports: [] },
    ];
    const { edges } = resolveImports(files);
    expect(edges).toEqual([{ fromPath: "src/a.ts", toPath: "src/helper.ts", specifier: "./helper.js" }]);
  });

  it("resolves a directory import to its index file", () => {
    const files = [
      { relativePath: "src/a.ts", language: "TypeScript", imports: ["./lib"] },
      { relativePath: "src/lib/index.ts", language: "TypeScript", imports: [] },
    ];
    const { edges } = resolveImports(files);
    expect(edges).toEqual([{ fromPath: "src/a.ts", toPath: "src/lib/index.ts", specifier: "./lib" }]);
  });

  it("resolves Java fully-qualified imports by package+classname suffix match", () => {
    const files = [
      {
        relativePath: "src/main/java/com/example/App.java",
        language: "Java",
        imports: ["com.example.util.Helper", "java.util.List"],
      },
      { relativePath: "src/main/java/com/example/util/Helper.java", language: "Java", imports: [] },
    ];
    const { edges, externalReferences } = resolveImports(files);

    expect(edges).toEqual([
      {
        fromPath: "src/main/java/com/example/App.java",
        toPath: "src/main/java/com/example/util/Helper.java",
        specifier: "com.example.util.Helper",
      },
    ]);
    expect(externalReferences.get("java.util.List")).toBe(1); 
  });

  it("does not resolve Java wildcard imports", () => {
    const files = [
      { relativePath: "src/main/java/com/example/App.java", language: "Java", imports: ["com.example.util.*"] },
      { relativePath: "src/main/java/com/example/util/Helper.java", language: "Java", imports: [] },
    ];
    const { edges, externalReferences } = resolveImports(files);
    expect(edges).toHaveLength(0);
    expect(externalReferences.get("com.example.util.*")).toBe(1);
  });

  it("does not fabricate a Java edge when two classes share a basename but different packages", () => {
    const files = [
      { relativePath: "src/main/java/com/example/App.java", language: "Java", imports: ["com.other.Helper"] },
      { relativePath: "src/main/java/com/example/util/Helper.java", language: "Java", imports: [] },
    ];
    const { edges, externalReferences } = resolveImports(files);
    expect(edges).toHaveLength(0);
    expect(externalReferences.get("com.other.Helper")).toBe(1);
  });
});

describe("buildArchitectureView", () => {
  it("aggregates files into modules at the requested depth and rolls up edges", () => {
    const files = [
      { relativePath: "src/a/index.ts", language: "TypeScript", loc: 10, isTest: false, imports: ["./helper", "../b/thing"] },
      { relativePath: "src/a/helper.ts", language: "TypeScript", loc: 5, isTest: false, imports: [] },
      { relativePath: "src/a/helper.test.ts", language: "TypeScript", loc: 8, isTest: true, imports: ["./helper"] },
      { relativePath: "src/b/thing.ts", language: "TypeScript", loc: 20, isTest: false, imports: [] },
    ];

    const view = buildArchitectureView(files, 2);

    const moduleA = view.nodes.find((n) => n.id === "src/a")!;
    expect(moduleA.fileCount).toBe(3);
    expect(moduleA.testFileCount).toBe(1);
    expect(moduleA.totalLoc).toBe(23);

    const moduleB = view.nodes.find((n) => n.id === "src/b")!;
    expect(moduleB.fileCount).toBe(1);

    expect(view.edges).toEqual([{ from: "src/a", to: "src/b", weight: 1 }]);
  });

  it("collapses to fewer, broader modules at a shallower depth", () => {
    const files = [
      { relativePath: "src/a/x/one.ts", language: "TypeScript", loc: 1, isTest: false, imports: [] },
      { relativePath: "src/a/y/two.ts", language: "TypeScript", loc: 1, isTest: false, imports: [] },
    ];

    const depth1 = buildArchitectureView(files, 1);
    expect(depth1.nodes.map((n) => n.id)).toEqual(["src"]);

    const depth3 = buildArchitectureView(files, 3);
    expect(depth3.nodes.map((n) => n.id).sort()).toEqual(["src/a/x", "src/a/y"]);
  });

  it("reports external dependencies sorted by reference count", () => {
    const files = [
      { relativePath: "src/a.ts", language: "TypeScript", loc: 1, isTest: false, imports: ["react", "lodash"] },
      { relativePath: "src/b.ts", language: "TypeScript", loc: 1, isTest: false, imports: ["react"] },
    ];
    const view = buildArchitectureView(files, 2);
    expect(view.externalDependencies[0]).toEqual({ specifier: "react", referenceCount: 2 });
    expect(view.externalDependencies[1]).toEqual({ specifier: "lodash", referenceCount: 1 });
  });

  it("groups root-level files (no directory) into a (root) module", () => {
    const files = [{ relativePath: "index.ts", language: "TypeScript", loc: 1, isTest: false, imports: [] }];
    const view = buildArchitectureView(files, 2);
    expect(view.nodes).toEqual([
      { id: "(root)", fileCount: 1, testFileCount: 0, totalLoc: 1, languages: ["TypeScript"] },
    ]);
  });
});
