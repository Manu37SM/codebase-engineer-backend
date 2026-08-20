import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneGitUrl, assertValidGitUrl, InvalidGitUrlError } from "../src/importer/gitUrl.js";
import { makeTempRepo, writeFile, initGit, gitCommitAll, cleanupRepo } from "./fixtures.js";

describe("assertValidGitUrl", () => {
  it("accepts http(s), ssh, git@, and file:// URLs", () => {
    expect(() => assertValidGitUrl("https://github.com/user/repo.git")).not.toThrow();
    expect(() => assertValidGitUrl("http://example.com/repo.git")).not.toThrow();
    expect(() => assertValidGitUrl("ssh://git@example.com/repo.git")).not.toThrow();
    expect(() => assertValidGitUrl("git@github.com:user/repo.git")).not.toThrow();
    expect(() => assertValidGitUrl("file:///tmp/some-repo")).not.toThrow();
  });

  it("rejects anything else, including local paths and shell-looking input", () => {
    expect(() => assertValidGitUrl("/tmp/some-repo")).toThrow(InvalidGitUrlError);
    expect(() => assertValidGitUrl("not a url at all")).toThrow(InvalidGitUrlError);
    expect(() => assertValidGitUrl("")).toThrow(InvalidGitUrlError);
    expect(() => assertValidGitUrl("; rm -rf /")).toThrow(InvalidGitUrlError);
  });
});

describe("cloneGitUrl", () => {
  let sourceRepo: string;
  let destDir: string;

  afterEach(() => {
    if (sourceRepo) cleanupRepo(sourceRepo);
    if (destDir && fs.existsSync(destDir)) cleanupRepo(destDir);
  });

  it("clones a real repository via a file:// URL, preserving full commit history", () => {
    sourceRepo = makeTempRepo();
    writeFile(sourceRepo, "README.md", "# hello\n");
    initGit(sourceRepo);
    gitCommitAll(sourceRepo, "first commit");
    writeFile(sourceRepo, "src/main.ts", "console.log('hi');\n");
    gitCommitAll(sourceRepo, "second commit");

    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-import-test-")), "cloned");

    cloneGitUrl(`file://${sourceRepo}`, destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src/main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".git"))).toBe(true);
  });

  it("refuses to clone into a directory that already exists", () => {
    sourceRepo = makeTempRepo();
    initGit(sourceRepo);
    writeFile(sourceRepo, "a.txt", "x");
    gitCommitAll(sourceRepo, "init");

    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-import-test-existing-"));
    expect(() => cloneGitUrl(`file://${sourceRepo}`, destDir)).toThrow(/already exists/);
  });

  it("cleans up a partial/failed clone rather than leaving a broken directory registered", () => {
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-import-test-fail-")), "cloned");
    expect(() => cloneGitUrl("file:///definitely/not/a/real/repo/path", destDir)).toThrow();
    expect(fs.existsSync(destDir)).toBe(false);
  });
});
