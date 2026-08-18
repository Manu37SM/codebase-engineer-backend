import { describe, it, expect, afterEach } from "vitest";
import { analyzeDependencies } from "../src/dependencies/index.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("analyzeDependencies — npm", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("parses direct dependencies and devDependencies from package.json", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { react: "^18.0.0", fastify: "^4.0.0" },
        devDependencies: { vitest: "^2.0.0" },
      })
    );

    const result = analyzeDependencies(root);

    expect(result.ecosystem).toBe("npm");
    expect(result.totalDirect).toBe(3);
    expect(result.direct).toContainEqual({ name: "react", versionRange: "^18.0.0", type: "dependency" });
    expect(result.direct).toContainEqual({ name: "vitest", versionRange: "^2.0.0", type: "devDependency" });
  });

  it("detects packages resolved at more than one version via a v2/v3 lockfile", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ dependencies: { app: "1.0.0" } }));
    writeFile(
      root,
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/lodash": { version: "4.17.21" },
          "node_modules/some-dep/node_modules/lodash": { version: "3.10.1" },
          "node_modules/react": { version: "18.3.1" },
        },
      })
    );

    const result = analyzeDependencies(root);

    expect(result.duplicatesSource).toBe("package-lock.json");
    expect(result.duplicates).toContainEqual({ name: "lodash", versions: ["3.10.1", "4.17.21"] });
    expect(result.duplicates.find((d) => d.name === "react")).toBeUndefined();
  });

  it("reports a note (not fabricated duplicates) for a v1 lockfile", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ dependencies: {} }));
    writeFile(root, "package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: {} }));

    const result = analyzeDependencies(root);

    expect(result.duplicates).toEqual([]);
    expect(result.duplicatesNote).toMatch(/version 1/);
  });

  it("reports a note when there's no lockfile at all", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));

    const result = analyzeDependencies(root);

    expect(result.duplicates).toEqual([]);
    expect(result.duplicatesNote).toMatch(/No package-lock\.json/);
  });
});

describe("analyzeDependencies — maven", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("parses groupId:artifactId dependencies with versions", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "pom.xml",
      `<project>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>2.7.0</version>
          </dependency>
          <dependency>
            <groupId>junit</groupId>
            <artifactId>junit</artifactId>
            <version>\${junit.version}</version>
          </dependency>
        </dependencies>
      </project>`
    );

    const result = analyzeDependencies(root);

    expect(result.ecosystem).toBe("maven");
    expect(result.totalDirect).toBe(2);
    expect(result.direct).toContainEqual({
      name: "org.springframework.boot:spring-boot-starter-web",
      versionRange: "2.7.0",
      type: "dependency",
    });
    // Unresolved property placeholder reported honestly as literal text, not resolved.
    expect(result.direct.find((d) => d.name === "junit:junit")?.versionRange).toBe("${junit.version}");
  });

  it("explains that duplicate-version detection isn't available for Maven", () => {
    root = makeTempRepo();
    writeFile(root, "pom.xml", "<project><dependencies></dependencies></project>");

    const result = analyzeDependencies(root);
    expect(result.duplicates).toEqual([]);
    expect(result.duplicatesNote).toMatch(/isn't available for Maven/);
  });
});

describe("analyzeDependencies — no supported manifest", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns an honest empty result instead of guessing", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "hello\n");

    const result = analyzeDependencies(root);
    expect(result.ecosystem).toBeNull();
    expect(result.direct).toEqual([]);
    expect(result.duplicatesNote).toMatch(/No supported manifest/);
  });
});
