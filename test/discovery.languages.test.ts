import { describe, it, expect } from "vitest";
import { languageForPath, detectLanguages } from "../src/discovery/languages.js";
import { walkRepository } from "../src/discovery/fileWalker.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("languageForPath (Task #89 — broadened language detection)", () => {
  it("recognizes the newly added languages", () => {
    expect(languageForPath("app.py")).toBe("Python");
    expect(languageForPath("script.rb")).toBe("Ruby");
    expect(languageForPath("main.go")).toBe("Go");
    expect(languageForPath("Program.cs")).toBe("C#");
    expect(languageForPath("index.php")).toBe("PHP");
    expect(languageForPath("main.c")).toBe("C");
    expect(languageForPath("util.h")).toBe("C");
    expect(languageForPath("main.cpp")).toBe("C++");
    expect(languageForPath("widget.hpp")).toBe("C++");
    expect(languageForPath("migration.sql")).toBe("SQL");
    expect(languageForPath("lib.rs")).toBe("Rust");
    expect(languageForPath("App.kt")).toBe("Kotlin");
    expect(languageForPath("ViewController.swift")).toBe("Swift");
  });

  it("still recognizes the original languages and returns null for unknown extensions", () => {
    expect(languageForPath("Main.java")).toBe("Java");
    expect(languageForPath("index.ts")).toBe("TypeScript");
    expect(languageForPath("index.js")).toBe("JavaScript");
    expect(languageForPath("README.md")).toBeNull();
    expect(languageForPath("Makefile")).toBeNull();
  });
});

describe("detectLanguages (Task #89)", () => {
  let root: string;

  it("counts a polyglot repository's files across the newly added languages", () => {
    root = makeTempRepo();
    try {
      writeFile(root, "backend/app.py", "def handler():\n    return 1\n");
      writeFile(root, "backend/utils.py", "def helper():\n    return 2\n");
      writeFile(root, "cli/main.go", "package main\n\nfunc main() {}\n");
      writeFile(root, "mobile/App.swift", "struct App {}\n");
      writeFile(root, "db/schema.sql", "CREATE TABLE foo (id INT);\n");
      writeFile(root, "README.md", "# hello\n");

      const files = walkRepository({ root });
      const result = detectLanguages(files);

      const python = result.languages.find((l) => l.language === "Python");
      const go = result.languages.find((l) => l.language === "Go");
      const swift = result.languages.find((l) => l.language === "Swift");
      const sql = result.languages.find((l) => l.language === "SQL");

      expect(python?.fileCount).toBe(2);
      expect(go?.fileCount).toBe(1);
      expect(swift?.fileCount).toBe(1);
      expect(sql?.fileCount).toBe(1);
      expect(result.otherFiles).toBe(1); 
    } finally {
      cleanupRepo(root);
    }
  });
});
