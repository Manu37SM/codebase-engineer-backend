import fs from "node:fs";
import path from "node:path";
import { detectPackageManagers } from "../discovery/packageManager.js";

export type TestFramework = "vitest" | "node-test" | "npm-script" | "maven" | "pytest" | "rspec" | "go-test" | "dotnet-test";

export interface TestCommandDetection {
  supported: boolean;
  framework: TestFramework | null;
  command: string | null;
  args: string[];

  reason?: string;
}

const DEFAULT_NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

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

    const usesNodeTestRunner = /\bnode\b[^&|;]*--test\b/.test(testScript);
    const managers = detectPackageManagers(root);
    const manager = managers[0] ?? "npm";
    const command = manager; 
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
