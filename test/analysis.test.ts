import { describe, it, expect, afterEach } from "vitest";
import { runAnalysis } from "../src/analysis/index.js";
import { buildAnalysisContext } from "../src/analysis/context.js";
import { missingTestsRule } from "../src/analysis/rules/missingTests.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("runAnalysis — large-file rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a file at or above the medium threshold and not below it", () => {
    root = makeTempRepo();
    const bigContent = Array.from({ length: 450 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const smallContent = "export const x = 1;\n";
    writeFile(root, "big.ts", bigContent);
    writeFile(root, "small.ts", smallContent);

    const { findings } = runAnalysis(root);
    const largeFileFindings = findings.filter((f) => f.ruleId === "large-file");

    expect(largeFileFindings).toHaveLength(1);
    expect(largeFileFindings[0].filePath).toBe("big.ts");
    expect(largeFileFindings[0].severity).toBe("medium");
    expect(largeFileFindings[0].lineEnd).toBe(450);
  });

  it("uses high severity for a very large file", () => {
    root = makeTempRepo();
    const hugeContent = Array.from({ length: 900 }, (_, i) => `// line ${i}`).join("\n");
    writeFile(root, "huge.ts", hugeContent);

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "large-file")!;
    expect(finding.severity).toBe("high");
  });
});

describe("runAnalysis — large-function rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a function whose body exceeds the line threshold", () => {
    root = makeTempRepo();
    const bodyLines = Array.from({ length: 70 }, (_, i) => `  doThing(${i});`).join("\n");
    writeFile(root, "big.ts", `function bigFunction() {\n${bodyLines}\n}\n`);

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "large-function");
    expect(finding).toBeTruthy();
    expect(finding!.evidence).toContain("bigFunction");
    expect(finding!.lineStart).toBe(1);
  });

  it("does not flag a short function", () => {
    root = makeTempRepo();
    writeFile(root, "small.ts", "function small() {\n  return 1;\n}\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "large-function")).toBeUndefined();
  });

  it("flags a large arrow function with a block body", () => {
    root = makeTempRepo();
    const bodyLines = Array.from({ length: 70 }, (_, i) => `  console.log(${i});`).join("\n");
    writeFile(root, "arrow.ts", `export const bigArrow = (x: number) => {\n${bodyLines}\n};\n`);

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "large-function");
    expect(finding).toBeTruthy();
    expect(finding!.evidence).toContain("bigArrow");
  });

  it("does not double-report a large outer function for its nested inner function", () => {
    root = makeTempRepo();
    const innerBody = Array.from({ length: 65 }, (_, i) => `    innerLine(${i});`).join("\n");
    const src = `function outer() {\n  function inner() {\n${innerBody}\n  }\n  inner();\n}\n`;
    writeFile(root, "nested.ts", src);

    const { findings } = runAnalysis(root);
    const largeFunctionFindings = findings.filter((f) => f.ruleId === "large-function");

    expect(largeFunctionFindings).toHaveLength(1);
    expect(largeFunctionFindings[0].evidence).toContain("outer");
  });
});

describe("runAnalysis — todo-fixme-density rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a file with several TODO/FIXME markers", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "messy.ts",
      "// TODO: fix this\nconst a = 1;\n// FIXME: broken\nconst b = 2;\n// TODO: also this\n"
    );

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "todo-fixme-density");
    expect(finding).toBeTruthy();
    expect(finding!.evidence).toContain("3 TODO/FIXME/XXX markers");
  });

  it("does not flag a file with only one or two markers", () => {
    root = makeTempRepo();
    writeFile(root, "clean.ts", "// TODO: minor\nconst a = 1;\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "todo-fixme-density")).toBeUndefined();
  });
});

describe("runAnalysis — missing-test-file rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a substantial source file with no corresponding test file", () => {
    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFile(root, "src/service.ts", body);

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "missing-test-file");
    expect(finding).toBeTruthy();
    expect(finding!.filePath).toBe("src/service.ts");
  });

  it("does not flag a file that has a matching .test file", () => {
    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFile(root, "src/service.ts", body);
    writeFile(root, "src/service.test.ts", "test('ok', () => {});\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "missing-test-file")).toBeUndefined();
  });

  it("does not flag a file that's imported and exercised by a differently-named test file", () => {

    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFile(root, "src/git.ts", body);
    writeFile(
      root,
      "test/discovery.test.ts",
      "import './../src/git.js';\ntest('covers git', () => {});\n"
    );

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "missing-test-file")).toBeUndefined();
  });

  it("does not flag a file only reachable transitively through an orchestrator the test imports", () => {

    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFile(root, "src/leaf.ts", body);
    writeFile(root, "src/orchestrator.ts", "import './leaf.js';\nexport const run = () => {};\n");
    writeFile(root, "test/orchestrator.test.ts", "import '../src/orchestrator.js';\ntest('ok', () => {});\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "missing-test-file")).toBeUndefined();
  });

  it("does not flag small files or skip-listed basenames like index.ts", () => {
    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFile(root, "src/index.ts", body); 
    writeFile(root, "src/tiny.ts", "export const a = 1;\n"); 

    const { findings } = runAnalysis(root);
    expect(findings.filter((f) => f.ruleId === "missing-test-file")).toHaveLength(0);
  });

  it("scales roughly linearly with repo size, not quadratically (perf regression guard)", () => {

    root = makeTempRepo();
    const body = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const FILE_COUNT = 1500;
    for (let i = 0; i < FILE_COUNT; i++) {

      writeFile(root, `src/module_${i}/unrelated_${i}.ts`, body);
    }

    const ctx = buildAnalysisContext(root);
    const start = performance.now();
    const findings = missingTestsRule.run(ctx);
    const elapsedMs = performance.now() - start;

    expect(findings).toHaveLength(FILE_COUNT);

    expect(elapsedMs).toBeLessThan(400);
  });
});

describe("runAnalysis — hardcoded-secret rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags an obvious hardcoded API key and redacts it in the evidence", () => {
    root = makeTempRepo();
    writeFile(root, "src/config.ts", `export const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\n`);

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "hardcoded-secret");
    expect(finding).toBeTruthy();
    expect(finding!.evidence).not.toContain("sk_live_ABCDEFGHIJKLMNOPQRSTUV");
    expect(finding!.evidence).toContain("redacted");
  });

  it("flags a private key block", () => {
    root = makeTempRepo();
    writeFile(root, "id_rsa", "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----\n");

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "hardcoded-secret");
    expect(finding).toBeTruthy();
    expect(finding!.severity).toBe("critical");
  });

  it("does not flag ordinary code with no credential-like assignment", () => {
    root = makeTempRepo();
    writeFile(root, "src/plain.ts", "export function add(a: number, b: number) { return a + b; }\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "hardcoded-secret")).toBeUndefined();
  });

  it("does not scan test files for secrets", () => {
    root = makeTempRepo();
    writeFile(root, "src/config.test.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\n`);

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "hardcoded-secret")).toBeUndefined();
  });
});

describe("runAnalysis — env-file-committed rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a real .env file", () => {
    root = makeTempRepo();
    writeFile(root, ".env", "SECRET=abc123\n");

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "env-file-committed");
    expect(finding).toBeTruthy();
    expect(finding!.filePath).toBe(".env");

    expect(finding!.evidence).not.toContain("abc123");
  });

  it("flags an environment-specific .env variant", () => {
    root = makeTempRepo();
    writeFile(root, ".env.production", "SECRET=abc123\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "env-file-committed")).toBeTruthy();
  });

  it("does not flag .env.example or similar templates", () => {
    root = makeTempRepo();
    writeFile(root, ".env.example", "SECRET=\n");
    writeFile(root, ".env.sample", "SECRET=\n");

    const { findings } = runAnalysis(root);
    expect(findings.filter((f) => f.ruleId === "env-file-committed")).toHaveLength(0);
  });
});

describe("runAnalysis — permissive-cors rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags Access-Control-Allow-Origin set to a wildcard", () => {
    root = makeTempRepo();
    writeFile(root, "src/server.ts", `res.setHeader("Access-Control-Allow-Origin", "*");\n`);

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "permissive-cors")).toBeTruthy();
  });

  it("flags a cors() options object allowing any origin", () => {
    root = makeTempRepo();
    writeFile(root, "src/app.ts", `app.use(cors({ origin: true, credentials: true }));\n`);

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "permissive-cors")).toBeTruthy();
  });

  it("does not flag a restricted CORS origin", () => {
    root = makeTempRepo();
    writeFile(root, "src/app.ts", `app.use(cors({ origin: "https://example.com" }));\n`);

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "permissive-cors")).toBeUndefined();
  });
});

describe("runAnalysis — disabled-tls-verification rule", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags rejectUnauthorized: false", () => {
    root = makeTempRepo();
    writeFile(root, "src/client.ts", "const agent = new https.Agent({ rejectUnauthorized: false });\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "disabled-tls-verification")).toBeTruthy();
  });

  it("flags a Python requests call with verify=False", () => {
    root = makeTempRepo();
    writeFile(root, "src/client.py", 'requests.get("https://example.com", verify=False)\n');

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "disabled-tls-verification")).toBeTruthy();
  });

  it("does not flag ordinary HTTPS client code", () => {
    root = makeTempRepo();
    writeFile(root, "src/client.ts", "const agent = new https.Agent({ keepAlive: true });\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "disabled-tls-verification")).toBeUndefined();
  });
});

describe("runAnalysis — missing-readme rule (documentation category)", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a project with no top-level README", () => {
    root = makeTempRepo();
    writeFile(root, "src/index.ts", "export const x = 1;\n");

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "missing-readme");
    expect(finding).toBeTruthy();
    expect(finding!.category).toBe("documentation");
  });

  it("does not flag a project with a README.md at the root", () => {
    root = makeTempRepo();
    writeFile(root, "README.md", "# My Project\n");
    writeFile(root, "src/index.ts", "export const x = 1;\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "missing-readme")).toBeUndefined();
  });

  it("does not count a README nested in a subdirectory as satisfying the rule", () => {
    root = makeTempRepo();
    writeFile(root, "docs/README.md", "# Not the root one\n");

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "missing-readme")).toBeTruthy();
  });
});

describe("runAnalysis — unpinned-dependency rule (dependencies category)", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("flags a dependency pinned to \"*\" or \"latest\"", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { lodash: "*", "left-pad": "latest", react: "^18.0.0" } })
    );

    const { findings } = runAnalysis(root);
    const finding = findings.find((f) => f.ruleId === "unpinned-dependency");
    expect(finding).toBeTruthy();
    expect(finding!.category).toBe("dependencies");
    expect(finding!.evidence).toContain("lodash@*");
    expect(finding!.evidence).not.toContain("react");
  });

  it("does not flag properly pinned/ranged dependencies", () => {
    root = makeTempRepo();
    writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { react: "^18.0.0", lodash: "~4.17.21" } })
    );

    const { findings } = runAnalysis(root);
    expect(findings.find((f) => f.ruleId === "unpinned-dependency")).toBeUndefined();
  });

  it("does not crash on a malformed package.json", () => {
    root = makeTempRepo();
    writeFile(root, "package.json", "{ not valid json");

    expect(() => runAnalysis(root)).not.toThrow();
  });
});
