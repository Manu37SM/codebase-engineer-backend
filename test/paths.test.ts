import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWithinRoot, assertValidProjectRoot, PathTraversalError } from "../src/security/paths.js";

describe("resolveWithinRoot", () => {
  const root = "/tmp/some-project";

  it("resolves a normal relative path inside the root", () => {
    expect(resolveWithinRoot(root, "src/index.ts")).toBe(
      path.resolve(root, "src/index.ts")
    );
  });

  it("allows the root itself", () => {
    expect(resolveWithinRoot(root, ".")).toBe(path.resolve(root));
  });

  it("rejects a relative traversal outside the root", () => {
    expect(() => resolveWithinRoot(root, "../../etc/passwd")).toThrow(
      PathTraversalError
    );
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects a crafted path that only textually starts with the root", () => {

    expect(() => resolveWithinRoot(root, "/tmp/some-project-evil/file")).toThrow(
      PathTraversalError
    );
  });
});

describe("assertValidProjectRoot", () => {
  it("accepts an existing absolute directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-root-test-"));
    expect(() => assertValidProjectRoot(dir)).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a relative path", () => {
    expect(() => assertValidProjectRoot("relative/path")).toThrow();
  });

  it("rejects a path that does not exist", () => {
    expect(() => assertValidProjectRoot("/tmp/definitely-does-not-exist-ce")).toThrow();
  });

  it("rejects a path that is a file, not a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-root-test-"));
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(filePath, "hi");
    expect(() => assertValidProjectRoot(filePath)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
