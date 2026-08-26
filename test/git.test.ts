import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { analyzeGit } from "../src/git/index.js";
import { getRecentCommits } from "../src/git/commits.js";
import { getFileChurn } from "../src/git/churn.js";
import { getUncommittedChanges } from "../src/git/diffStat.js";
import { makeTempRepo, writeFile, initGit, gitCommitAll, cleanupRepo } from "./fixtures.js";

describe("analyzeGit — non-git repository", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns an empty, non-fabricated result when there's no .git directory", () => {
    root = makeTempRepo();
    writeFile(root, "a.txt", "hello\n");

    const result = analyzeGit(root);

    expect(result.isGitRepository).toBe(false);
    expect(result.branch).toBeNull();
    expect(result.workingTreeStatus).toBeNull();
    expect(result.recentCommits).toEqual([]);
    expect(result.fileChurn).toEqual([]);
    expect(result.uncommittedChanges).toBeNull();
  });
});

describe("getRecentCommits", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns commits newest-first with parsed fields", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "one\n");
    gitCommitAll(root, "first commit");
    writeFile(root, "b.txt", "two\n");
    gitCommitAll(root, "second commit");

    const commits = getRecentCommits(root, 10);

    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe("second commit");
    expect(commits[1].message).toBe("first commit");
    expect(commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].shortHash.length).toBeGreaterThan(0);
    expect(commits[0].authorEmail).toBe("test@example.com");
    expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects the commit limit", () => {
    root = makeTempRepo();
    initGit(root);
    for (let i = 0; i < 5; i++) {
      writeFile(root, "a.txt", `content ${i}\n`);
      gitCommitAll(root, `commit ${i}`);
    }

    const commits = getRecentCommits(root, 2);
    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe("commit 4");
    expect(commits[1].message).toBe("commit 3");
  });

  it("does not break on a commit subject containing pipe characters", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.txt", "one\n");
    gitCommitAll(root, "fix: a | b | c edge case");

    const commits = getRecentCommits(root, 5);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("fix: a | b | c edge case");
  });

  it("returns an empty array for a git repo with no commits yet", () => {
    root = makeTempRepo();
    initGit(root);

    expect(getRecentCommits(root, 10)).toEqual([]);
  });
});

describe("getFileChurn", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("counts commits touching each file, most-churned first", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "hot.ts", "v1\n");
    writeFile(root, "cold.ts", "v1\n");
    gitCommitAll(root, "initial");
    writeFile(root, "hot.ts", "v2\n");
    gitCommitAll(root, "touch hot again");
    writeFile(root, "hot.ts", "v3\n");
    gitCommitAll(root, "touch hot a third time");

    const churn = getFileChurn(root, 3650); 

    const hot = churn.find((c) => c.path === "hot.ts");
    const cold = churn.find((c) => c.path === "cold.ts");
    expect(hot?.commitCount).toBe(3);
    expect(cold?.commitCount).toBe(1);
    expect(churn[0].path).toBe("hot.ts"); 
  });

  it("excludes commits older than the window", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "old.ts", "v1\n");

    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "old commit"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: twoYearsAgo,
        GIT_COMMITTER_DATE: twoYearsAgo,
      },
    });

    const churn = getFileChurn(root, 90);
    expect(churn.find((c) => c.path === "old.ts")).toBeUndefined();
  });
});

describe("getUncommittedChanges", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns null when there's no HEAD to diff against", () => {
    root = makeTempRepo();
    initGit(root);
    expect(getUncommittedChanges(root)).toBeNull();
  });

  it("summarizes staged and unstaged changes relative to HEAD", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.ts", "line1\nline2\nline3\n");
    gitCommitAll(root, "initial");

    writeFile(root, "a.ts", "line1\nCHANGED\nline3\nline4\n");

    writeFile(root, "b.ts", "new file\n");
    execFileSync("git", ["add", "b.ts"], { cwd: root });

    const diff = getUncommittedChanges(root);

    expect(diff).not.toBeNull();
    expect(diff!.filesChanged).toBe(2);
    const aStat = diff!.files.find((f) => f.path === "a.ts");
    const bStat = diff!.files.find((f) => f.path === "b.ts");
    expect(aStat?.insertions).toBe(2); 
    expect(aStat?.deletions).toBe(1); 
    expect(bStat?.insertions).toBe(1);
    expect(bStat?.deletions).toBe(0);
  });

  it("returns an empty summary (not null) for a clean working tree", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.ts", "content\n");
    gitCommitAll(root, "initial");

    const diff = getUncommittedChanges(root);
    expect(diff).toEqual({ filesChanged: 0, insertions: 0, deletions: 0, files: [] });
  });
});

describe("analyzeGit — composed result against a real repo", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("combines branch, status, commits, churn, and uncommitted changes", () => {
    root = makeTempRepo();
    initGit(root);
    writeFile(root, "a.ts", "content\n");
    gitCommitAll(root, "initial commit");
    writeFile(root, "a.ts", "changed content\n");

    const result = analyzeGit(root, { commitLimit: 5, churnWindowDays: 365 });

    expect(result.isGitRepository).toBe(true);
    expect(result.branch).toBeTruthy();
    expect(result.workingTreeStatus?.clean).toBe(false);
    expect(result.recentCommits).toHaveLength(1);
    expect(result.fileChurn.find((c) => c.path === "a.ts")?.commitCount).toBe(1);
    expect(result.uncommittedChanges?.filesChanged).toBe(1);
    expect(result.churnWindowDays).toBe(365);
  });
});
