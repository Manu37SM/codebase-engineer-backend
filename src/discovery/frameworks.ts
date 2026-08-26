import fs from "node:fs";
import path from "node:path";

const NPM_DEPENDENCY_FRAMEWORK_MAP: Record<string, string> = {
  react: "React",
  "react-dom": "React",
  vue: "Vue",
  "@angular/core": "Angular",
  next: "Next.js",
  vite: "Vite",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  svelte: "Svelte",
};

const MAVEN_DEPENDENCY_FRAMEWORK_MAP: { pattern: RegExp; framework: string }[] = [
  { pattern: /spring-boot/i, framework: "Spring Boot" },
  { pattern: /<groupId>\s*org\.springframework\s*<\/groupId>/i, framework: "Spring" },
  { pattern: /quarkus/i, framework: "Quarkus" },
  { pattern: /micronaut/i, framework: "Micronaut" },
];

export function detectFrameworksFromPackageJson(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return []; 
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const frameworks = new Set<string>();
  for (const depName of Object.keys(allDeps)) {
    const framework = NPM_DEPENDENCY_FRAMEWORK_MAP[depName];
    if (framework) frameworks.add(framework);
  }
  return Array.from(frameworks);
}

export function detectFrameworksFromPom(root: string): string[] {
  const pomPath = path.join(root, "pom.xml");
  if (!fs.existsSync(pomPath)) return [];

  let contents: string;
  try {
    contents = fs.readFileSync(pomPath, "utf-8");
  } catch {
    return [];
  }

  const frameworks = new Set<string>();
  for (const rule of MAVEN_DEPENDENCY_FRAMEWORK_MAP) {
    if (rule.pattern.test(contents)) frameworks.add(rule.framework);
  }
  return Array.from(frameworks);
}

export function detectFrameworks(root: string): string[] {
  const fromNpm = detectFrameworksFromPackageJson(root);
  const fromMaven = detectFrameworksFromPom(root);
  return Array.from(new Set([...fromNpm, ...fromMaven])).sort();
}
