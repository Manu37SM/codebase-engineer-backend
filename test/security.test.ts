import { describe, it, expect, afterEach } from "vitest";
import { scanSecurity } from "../src/security/scan.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

describe("scanSecurity", () => {
  let root: string;
  afterEach(() => root && cleanupRepo(root));

  it("returns only security-category findings, computed fresh each call", () => {
    root = makeTempRepo();
    writeFile(root, ".env", "SECRET=abc\n");
    writeFile(root, "src/app.ts", `app.use(cors({ origin: true }));\n`);

    const bigContent = Array.from({ length: 500 }, (_, i) => `const line${i} = ${i};`).join("\n");
    writeFile(root, "src/big.ts", bigContent);

    const result = scanSecurity(root);

    expect(result.findings.every((f) => f.category === "security")).toBe(true);
    expect(result.findings.find((f) => f.ruleId === "env-file-committed")).toBeTruthy();
    expect(result.findings.find((f) => f.ruleId === "permissive-cors")).toBeTruthy();
    expect(result.findings.find((f) => f.ruleId === "large-file")).toBeUndefined();
    expect(result.scannedAt).toBeTruthy();
  });

  it("returns no findings for a clean repo", () => {
    root = makeTempRepo();
    writeFile(root, "src/clean.ts", "export function add(a: number, b: number) { return a + b; }\n");

    const result = scanSecurity(root);
    expect(result.findings).toEqual([]);
  });
});
