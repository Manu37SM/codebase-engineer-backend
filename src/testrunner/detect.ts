import fs from "node:fs";
import path from "node:path";
import { detectPackageManagers } from "../discovery/packageManager.js";

export type TestFramework = "vitest" | "node-test" | "npm-script" | "maven";

export interface TestCommandDetection {
  supported: boolean;
  framework: TestFramework | null;
  command: string | null;
  args: string[];
  /** Why detection failed — set only when `supported` is false. */
  reason?: string;
}

const DEFAULT_NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

/**
 * Picks a concrete, runnable test command for a project, matching the build
 * systems this product actually supports running (per
 * `discovery/buildSystem.ts`): Maven and the npm family (npm/pnpm/yarn).
 * Gradle is detected elsewhere for reporting purposes but intentionally not
 * run here — see the "Gradle-detected-only" note in buildSystem.ts and the
 * corresponding FEATURE.md gap.
 *
 * Never guesses at a command that isn't actually present — an npm project
 * with no `scripts.test` (or only the default CRA/npm-init placeholder) is
 * reported as unsupported with a reason, not silently skipped or fabricated.
 */
export function detectTestCommand(root: string): TestCommandDetection {
  if (fs.existsSync(path.join(root, "pom.xml"))) {
    return {
      supported: true,
      framework: "maven",
      command: "mvn",
      args: ["-B", "-q", "test"],
    };
  }

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {
      return {
        supported: false,
        framework: null,
        command: null,
        args: [],
        reason: "package.json exists but could not be parsed as JSON",
      };
    }

    const testScript = pkg.scripts?.test;
    if (!testScript || testScript.trim() === DEFAULT_NPM_PLACEHOLDER) {
      return {
        supported: false,
        framework: null,
        command: null,
        args: [],
        reason: "No test script defined in package.json",
      };
    }

    const hasVitest = Boolean(pkg.dependencies?.vitest || pkg.devDependencies?.vitest);
    // Node's own built-in test runner (`node --test`) needs no declared
    // dependency — it ships with Node itself — so it can only be detected
    // from the test script's own invocation, unlike vitest above.
    const usesNodeTestRunner = /\bnode\b[^&|;]*--test\b/.test(testScript);
    const managers = detectPackageManagers(root);
    const manager = managers[0] ?? "npm";
    const command = manager; // "npm" | "pnpm" | "yarn" are all valid executables
    const args = manager === "yarn" ? ["test"] : ["run", "test"];

    return {
      supported: true,
      framework: hasVitest ? "vitest" : usesNodeTestRunner ? "node-test" : "npm-script",
      command,
      args,
    };
  }

  if (
    fs.existsSync(path.join(root, "build.gradle")) ||
    fs.existsSync(path.join(root, "build.gradle.kts"))
  ) {
    return {
      supported: false,
      framework: null,
      command: null,
      args: [],
      reason: "Gradle test execution is not yet supported",
    };
  }

  return {
    supported: false,
    framework: null,
    command: null,
    args: [],
    reason: "No supported build system detected (Maven or npm/pnpm/yarn)",
  };
}
