import { describe, it, expect, afterEach } from "vitest";
import { getUncommittedDiffForFile } from "../src/git/fileDiff.js";
import { makeTempRepo, writeFile, cleanupRepo, initGit, gitCommitAll } from "./fixtures.js";
import { execFileSync } from "node:child_process";

describe("getUncommittedDiffForFile", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns null for a non-git directory", () => {
    root = makeTempRepo();
    writeFile(root, "a.txt", "hello\n");
    expect(getUncommittedDiffForFile(root, "a.txt")).toBeNull();
  });

  it("returns null when there's no HEAD yet (no commits)", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "hello\n");
    expect(getUncommittedDiffForFile(root, "a.txt")).toBeNull();
  });

  it("returns null for a file with no uncommitted changes", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "hello\n");
    gitCommitAll(root, "initial");
    expect(getUncommittedDiffForFile(root, "a.txt")).toBeNull();
  });

  it("returns a real unified diff for a file with uncommitted changes", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "hello\n");
    gitCommitAll(root, "initial");
    writeFile(root, "a.txt", "hello\nworld\n");

    const diff = getUncommittedDiffForFile(root, "a.txt");
    expect(diff).not.toBeNull();
    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+world");
  });

  it("returns null for a different, unmodified file even when other files changed", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "hello\n");
    writeFile(root, "b.txt", "unchanged\n");
    gitCommitAll(root, "initial");
    writeFile(root, "a.txt", "hello\nworld\n");

    expect(getUncommittedDiffForFile(root, "b.txt")).toBeNull();
  });

  it("does not shell-interpret a path with special characters (execFileSync argv, not shell)", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "weird; rm -rf .git", "content\n");
    gitCommitAll(root, "initial");

    getUncommittedDiffForFile(root, "weird; rm -rf .git");
    expect(() => execFileSync("git", ["status"], { cwd: root })).not.toThrow();
  });
});
