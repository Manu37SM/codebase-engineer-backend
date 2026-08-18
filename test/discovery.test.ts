import { describe, it, expect, afterEach } from "vitest";
import { discoverRepository } from "../src/discovery/index.js";
import { makeTempRepo, writeFile, initGit, gitCommitAll, cleanupRepo } from "./fixtures.js";

describe("discoverRepository — JS/TS npm project", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("detects languages, npm build system/package manager, and frameworks", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          dependencies: { react: "^18.0.0", express: "^4.19.0" },
          devDependencies: { typescript: "^5.5.0" },
        },
        null,
        2
      )
    );
    writeFile(root, "package-lock.json", "{}");
    writeFile(root, "src/index.ts", "export const x = 1;\nconsole.log(x);\n");
    writeFile(root, "src/App.tsx", "export function App() { return null; }\n");
    writeFile(root, "src/legacy.js", "module.exports = {};\n");
    // Should be excluded from language counts and LOC entirely.
    writeFile(root, "node_modules/some-dep/index.js", "// vendored, must be ignored\n".repeat(500));

    const result = discoverRepository(root);

    expect(result.buildSystems).toContain("npm");
    expect(result.packageManagers).toContain("npm");
    expect(result.dependencyManifests).toContain("package.json");
    expect(result.frameworks).toEqual(expect.arrayContaining(["React", "Express"]));

    const ts = result.languages.find((l) => l.language === "TypeScript");
    const js = result.languages.find((l) => l.language === "JavaScript");
    expect(ts?.fileCount).toBe(2); // index.ts + App.tsx
    expect(js?.fileCount).toBe(1); // legacy.js only — node_modules excluded
    expect(ts!.approxLoc).toBeGreaterThan(0);

    expect(result.isGitRepository).toBe(false);
    expect(result.gitBranch).toBeNull();
  });

  it("respects a root .gitignore in addition to default excludes", () => {
    root = makeTempRepo();
    writeFile(root, ".gitignore", "ignored-dir/\n*.log\n");
    writeFile(root, "src/keep.ts", "export const a = 1;\n");
    writeFile(root, "ignored-dir/skip.ts", "export const b = 2;\n");
    writeFile(root, "debug.log", "noise\n");

    const result = discoverRepository(root);
    const ts = result.languages.find((l) => l.language === "TypeScript");
    expect(ts?.fileCount).toBe(1);
  });
});

describe("discoverRepository — Maven/Java project", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("detects Maven build system and Spring Boot framework", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "pom.xml",
      `<project>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
          </dependency>
        </dependencies>
      </project>`
    );
    writeFile(root, "src/main/java/App.java", "public class App {\n  public static void main(String[] a) {}\n}\n");
    writeFile(root, "target/App.class", "compiled-binary-placeholder");

    const result = discoverRepository(root);

    expect(result.buildSystems).toContain("maven");
    expect(result.dependencyManifests).toContain("pom.xml");
    expect(result.frameworks).toContain("Spring Boot");

    const java = result.languages.find((l) => l.language === "Java");
    expect(java?.fileCount).toBe(1); // target/ excluded
  });
});

describe("discoverRepository — Git detection", () => {
  let root: string;

  afterEach(() => {
    if (root) cleanupRepo(root);
  });

  it("reports a clean working tree on a fresh commit", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "# fixture\n");
    initGit(root);
    gitCommitAll(root, "initial commit");

    const result = discoverRepository(root);
    expect(result.isGitRepository).toBe(true);
    expect(result.gitBranch).toBeTruthy();
    expect(result.workingTreeStatus?.clean).toBe(true);
  });

  it("reports modified/untracked counts after changes", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "# fixture\n");
    initGit(root);
    gitCommitAll(root, "initial commit");

    writeFile(root, "README.md", "# fixture (changed)\n");
    writeFile(root, "NEW.md", "new file\n");

    const result = discoverRepository(root);
    expect(result.workingTreeStatus?.clean).toBe(false);
    expect(result.workingTreeStatus?.modified).toBeGreaterThanOrEqual(1);
    expect(result.workingTreeStatus?.untracked).toBeGreaterThanOrEqual(1);
  });
});
