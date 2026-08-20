import fs from "node:fs";
import path from "node:path";
import { detectPackageManagers } from "../discovery/packageManager.js";

export type TestFramework = "vitest" | "node-test" | "npm-script" | "maven" | "pytest" | "rspec" | "go-test" | "dotnet-test";

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

  if (fs.existsSync(path.join(root, "go.mod"))) {
    return { supported: true, framework: "go-test", command: "go", args: ["test", "-v", "./..."] };
  }

  if (findFileWithExtension(root, [".sln", ".csproj"])) {
    return { supported: true, framework: "dotnet-test", command: "dotnet", args: ["test"] };
  }

  const gemfilePath = path.join(root, "Gemfile");
  const hasGemfile = fs.existsSync(gemfilePath);
  const gemfileMentionsRspec = hasGemfile && safeReadIncludes(gemfilePath, "rspec");
  const hasRspecMarkers = fs.existsSync(path.join(root, ".rspec")) || fs.existsSync(path.join(root, "spec"));
  if (gemfileMentionsRspec || hasRspecMarkers) {
    return hasGemfile
      ? { supported: true, framework: "rspec", command: "bundle", args: ["exec", "rspec"] }
      : { supported: true, framework: "rspec", command: "rspec", args: [] };
  }

  if (detectsPytest(root)) {
    return { supported: true, framework: "pytest", command: "pytest", args: ["-q"] };
  }

  return {
    supported: false,
    framework: null,
    command: null,
    args: [],
    reason: "No supported build system detected (Maven, npm/pnpm/yarn, Go, .NET, RSpec, or pytest)",
  };
}

/** Non-recursive: only checks files directly in `root`, matching how a `.sln`/`.csproj` normally sits at a .NET project's root. */
function findFileWithExtension(root: string, extensions: string[]): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return false;
  }
  return entries.some((name) => extensions.some((ext) => name.toLowerCase().endsWith(ext)));
}

function safeReadIncludes(filePath: string, needle: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf-8").toLowerCase().includes(needle.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Python has no single canonical "this is a pytest project" file the way
 * Maven has `pom.xml` — pytest is detected from any of the conventional
 * signals: a dedicated config file/section, a `conftest.py` fixture file,
 * or pytest listed as a dependency. Deliberately does NOT trigger on a
 * bare `setup.py`/`.py` file alone — that would misclassify any Python
 * project as pytest-testable even with no tests or a different test
 * framework (unittest, nose, etc.) in use.
 */
function detectsPytest(root: string): boolean {
  if (fs.existsSync(path.join(root, "pytest.ini"))) return true;
  if (fs.existsSync(path.join(root, "conftest.py"))) return true;

  const pyprojectPath = path.join(root, "pyproject.toml");
  if (fs.existsSync(pyprojectPath) && safeReadIncludes(pyprojectPath, "pytest")) return true;

  const setupCfgPath = path.join(root, "setup.cfg");
  if (fs.existsSync(setupCfgPath) && safeReadIncludes(setupCfgPath, "[tool:pytest]")) return true;

  for (const reqFile of ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "dev-requirements.txt"]) {
    const reqPath = path.join(root, reqFile);
    if (fs.existsSync(reqPath) && safeReadIncludes(reqPath, "pytest")) return true;
  }

  return false;
}
