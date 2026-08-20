import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertValidRepoFullName,
  buildGitHubCloneUrl,
  cloneWithToken,
  InvalidRepoFullNameError,
} from "../src/importer/githubClone.js";
import { makeTempRepo, writeFile, initGit, gitCommitAll, cleanupRepo } from "./fixtures.js";

describe("assertValidRepoFullName / buildGitHubCloneUrl", () => {
  it("accepts a plausible owner/repo identifier and builds the expected URL", () => {
    expect(() => assertValidRepoFullName("octocat/Hello-World")).not.toThrow();
    expect(buildGitHubCloneUrl("octocat/Hello-World")).toBe("https://github.com/octocat/Hello-World.git");
  });

  it("rejects anything that isn't a bare owner/repo pair", () => {
    expect(() => assertValidRepoFullName("not-a-full-name")).toThrow(InvalidRepoFullNameError);
    expect(() => assertValidRepoFullName("https://github.com/octocat/Hello-World")).toThrow(InvalidRepoFullNameError);
    expect(() => assertValidRepoFullName("owner/repo/extra")).toThrow(InvalidRepoFullNameError);
    expect(() => assertValidRepoFullName("")).toThrow(InvalidRepoFullNameError);
    expect(() => assertValidRepoFullName("owner/; rm -rf /")).toThrow(InvalidRepoFullNameError);
  });
});

describe("cloneWithToken", () => {
  let sourceRepo: string;
  let destDir: string;

  afterEach(() => {
    if (sourceRepo) cleanupRepo(sourceRepo);
    if (destDir && fs.existsSync(destDir)) cleanupRepo(destDir);
  });

  it("clones a real repository via a file:// URL with an auth header attached (harmless for file://)", () => {
    sourceRepo = makeTempRepo();
    writeFile(sourceRepo, "README.md", "# hello\n");
    initGit(sourceRepo);
    gitCommitAll(sourceRepo, "first commit");

    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-gh-clone-test-")), "cloned");

    cloneWithToken(`file://${sourceRepo}`, destDir, "fake-token-value");

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".git"))).toBe(true);
  });

  it("refuses to clone into a directory that already exists", () => {
    sourceRepo = makeTempRepo();
    initGit(sourceRepo);
    writeFile(sourceRepo, "a.txt", "x");
    gitCommitAll(sourceRepo, "init");

    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-gh-clone-test-existing-"));
    expect(() => cloneWithToken(`file://${sourceRepo}`, destDir, "fake-token")).toThrow(/already exists/);
  });

  it("cleans up a partial/failed clone and never leaks the token/header value in the thrown error", () => {
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-gh-clone-test-fail-")), "cloned");
    let thrown: Error | undefined;
    try {
      cloneWithToken("file:///definitely/not/a/real/repo/path", destDir, "super-secret-token-xyz");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeTruthy();
    expect(fs.existsSync(destDir)).toBe(false);
    expect(thrown!.message).not.toContain("super-secret-token-xyz");
  });
});
