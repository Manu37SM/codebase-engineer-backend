import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectByRootPath,
  listProjects,
  saveDiscoverySnapshot,
  getLatestSnapshot,
  setProjectApplyMode,
} from "../db/projectRepo.js";
import { assertValidProjectRoot, resolveWithinRoot, PathTraversalError } from "../security/paths.js";
import { detectSubProjects } from "../discovery/multiProject.js";
import { cloneGitUrl } from "../importer/gitUrl.js";
import { downloadAndExtractZip } from "../importer/zipUrl.js";
import { checkAiOperationAllowed } from "../billing/usageLimiter.js";
import { discoverRepository } from "../discovery/index.js";
import { indexRepository } from "../indexer/index.js";
import { replaceProjectFiles, listProjectFiles, listAllProjectFiles } from "../db/fileRepo.js";
import { buildArchitectureView } from "../architecture/aggregate.js";
import { runAnalysis } from "../analysis/index.js";
import {
  replaceProjectFindings,
  listFindings,
  createAnalysisRun,
  finishAnalysisRun,
  getLatestAnalysisRun,
  listAnalysisRuns,
  getFindingById,
} from "../db/findingRepo.js";
import { analyzeGit } from "../git/index.js";
import { runTests } from "../testrunner/run.js";
import { saveTestRun, getTestRun, listTestRuns, deleteTestRun, deleteAllTestRuns } from "../db/testRunRepo.js";
import { scanSecurity } from "../security/scan.js";
import { analyzeDependencies } from "../dependencies/index.js";
import { buildAuditReport, buildAuditMarkdown } from "../audit/index.js";
import { selectContextForFinding } from "../ai/context/select.js";
import { explainFinding, EXPLAIN_FINDING_OPERATION_TYPE } from "../ai/workflows/explainFinding.js";
import {
  analyzeRootCause,
  parseRootCauseSections,
  ROOT_CAUSE_ANALYSIS_OPERATION_TYPE,
} from "../ai/workflows/rootCauseAnalysis.js";
import { planFix, parseFixPlanSections, FIX_PLAN_OPERATION_TYPE } from "../ai/workflows/fixPlan.js";
import { generatePatch } from "../ai/workflows/generatePatch.js";
import { applyPatchToDisk } from "../patch/applyPatch.js";
import { buildPatchZip } from "../patch/exportPatchZip.js";
import {
  createPatch,
  createPatchReview,
  getPatchById,
  listPatchesForFinding,
  listPatchesForProject,
  setPatchApplyResult,
  setPatchDiff,
  updatePatchStatus,
} from "../db/patchRepo.js";
import {
  getLatestSuccessfulResponse,
  getLatestSuccessfulResponseForTestRun,
  getLatestSuccessfulResponseForPatch,
} from "../db/aiRequestRepo.js";
import { diagnoseFailure, parseFailureDiagnosisSections, FAILURE_DIAGNOSIS_OPERATION_TYPE } from "../ai/workflows/diagnoseFailure.js";
import { selfReviewPatch, parseSelfReviewSections, SELF_REVIEW_OPERATION_TYPE } from "../ai/workflows/selfReview.js";
import { getProviderConfigById, listProviderConfigs, type ProviderConfigRecord } from "../db/aiProviderRepo.js";
import { AIProviderError } from "../ai/provider/types.js";
import { generateTest } from "../ai/workflows/generateTest.js";
import {
  createGeneratedTest,
  createGeneratedTestReview,
  getGeneratedTestById,
  listGeneratedTestsForFinding,
  listGeneratedTestsForProject,
  setGeneratedTestContent,
  setGeneratedTestRunResult,
  updateGeneratedTestStatus,
} from "../db/generatedTestRepo.js";
import fs from "node:fs";
import path from "node:path";

interface RegisterProjectsRoutesOptions {
  db: DB;
  /** Where imported (git-URL/zip-URL) project clones are stored (Task #85) — see BuildAppOptions.dataDir in app.ts. */
  dataDir: string;
}

/**
 * Resolves which enabled provider a Finding-target AI workflow route
 * should use — either the one named by `providerId`, or the first enabled
 * one if none was specified — with the same honest 400 messages every
 * such route needs. Shared by `/explain` and `/root-cause` (Phase 14/15)
 * rather than duplicated per route.
 *
 * Also the single choke point all 7 AI-spending routes go through (Phase
 * 26): checks `checkAiOperationAllowed()` before resolving a provider, so
 * a usage-limited instance never even gets to "which provider" before
 * being told the monthly limit is reached. When billing isn't configured
 * (the default), `checkAiOperationAllowed()` always returns
 * `allowed: true` — zero behavior change for every instance that hasn't
 * opted into billing, per docs/PRD.md §3's "AI is optional" principle.
 */
function resolveEnabledProvider(
  db: DB,
  body: { providerId?: string } | undefined
): { provider: ProviderConfigRecord } | { error: { status: number; message: string } } {
  const usage = checkAiOperationAllowed(db);
  if (!usage.allowed) {
    return { error: { status: 402, message: usage.reason ?? "Monthly AI operation limit reached." } };
  }

  const providerRecord = body?.providerId
    ? getProviderConfigById(db, body.providerId)
    : listProviderConfigs(db).find((p) => p.enabled === 1);

  if (!providerRecord) {
    return {
      error: {
        status: 400,
        message: body?.providerId
          ? "The requested AI provider was not found."
          : "No AI provider is configured and enabled. Configure one in AI Mode first.",
      },
    };
  }
  if (providerRecord.enabled !== 1) {
    return { error: { status: 400, message: `Provider "${providerRecord.name}" is not enabled.` } };
  }
  return { provider: providerRecord };
}

export function registerProjectsRoutes(
  app: FastifyInstance,
  { db, dataDir }: RegisterProjectsRoutesOptions
) {
  app.post("/api/v1/projects", async (request, reply) => {
    const body = request.body as { name?: string; rootPath?: string } | undefined;
    if (!body?.name || !body?.rootPath) {
      return reply.status(400).send({ error: "name and rootPath are required" });
    }

    try {
      assertValidProjectRoot(body.rootPath);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const existing = getProjectByRootPath(db, body.rootPath);
    if (existing) {
      return reply.status(409).send({
        error: "A project is already registered for this root path",
        project: existing,
      });
    }

    const project = createProject(db, randomUUID(), body.name, body.rootPath);
    return reply.status(201).send({ project });
  });

  /**
   * Registration by remote git URL or plain zip/download URL (Task #85) —
   * two of the four project sources the user asked for. Clones/downloads
   * onto THIS machine under its own data directory, then registers the
   * result exactly like any other local path — still local-first, nothing
   * is ever stored remotely.
   */
  app.post("/api/v1/projects/import", async (request, reply) => {
    const body = request.body as { name?: string; sourceType?: string; sourceUrl?: string } | undefined;
    if (!body?.name || !body?.sourceUrl) {
      return reply.status(400).send({ error: "name and sourceUrl are required" });
    }
    if (body.sourceType !== "git" && body.sourceType !== "zip") {
      return reply.status(400).send({ error: "sourceType must be 'git' or 'zip'" });
    }

    const importId = randomUUID();
    const destDir = path.join(dataDir, "imports", importId);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });

    try {
      if (body.sourceType === "git") {
        cloneGitUrl(body.sourceUrl, destDir);
      } else {
        await downloadAndExtractZip(body.sourceUrl, destDir);
      }
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    try {
      assertValidProjectRoot(destDir);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const project = createProject(db, randomUUID(), body.name, destDir);
    return reply.status(201).send({ project });
  });

  app.get("/api/v1/projects", async () => {
    return { projects: listProjects(db) };
  });

  app.get("/api/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });
    const latestSnapshot = getLatestSnapshot(db, id);
    return { project, latestSnapshot: latestSnapshot ?? null };
  });

  /**
   * Removes a project (and everything derived from it — findings, runs,
   * patches, etc., via cascade — see `deleteProject`'s own doc comment)
   * from Codebase Engineer's workspace. Task #94 — "remove projects from
   * the workspace". Never touches the actual repository on disk: this
   * only forgets Codebase Engineer's own record of it.
   */
  app.delete("/api/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });
    deleteProject(db, id);
    return reply.status(204).send();
  });

  /**
   * Task #90: the settings toggle deciding whether AI-Mode's `/apply`
   * writes an approved patch straight to this project's real files
   * ("direct", the default — unchanged behavior for every project
   * predating this setting) or refuses in favor of the zip-download route
   * ("download"), so someone can review/test a change by hand first.
   * Deliberately per-project, not global: a person may trust a scratch
   * checkout with direct writes while wanting review-first for a real
   * working copy.
   */
  app.patch("/api/v1/projects/:id/settings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const body = request.body as { applyMode?: string } | undefined;
    if (body?.applyMode === undefined) {
      return reply.status(400).send({ error: "applyMode is required." });
    }
    if (body.applyMode !== "direct" && body.applyMode !== "download") {
      return reply.status(400).send({ error: 'applyMode must be "direct" or "download".' });
    }

    setProjectApplyMode(db, id, body.applyMode);
    return reply.status(200).send({ project: getProjectById(db, id) });
  });

  /**
   * Multi-project-in-folder detection (Task #87) — scans this project's
   * registered root for other plausible project roots nested inside it
   * (a monorepo, an org-wide "Download ZIP", a folder that turns out to
   * hold several unrelated projects). Read-only: never registers anything
   * by itself — that's the paired `/subprojects/register` route below,
   * left as an explicit, separate, human-triggered action.
   */
  app.get("/api/v1/projects/:id/subprojects", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    let result;
    try {
      result = detectSubProjects(project.root_path);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    return reply.status(200).send(result);
  });

  /**
   * Registers one detected sub-directory as its own separate project —
   * the parent project registration is left untouched (both can coexist),
   * matching the "never silently replace what the user already set up"
   * convention the rest of this product follows (e.g. Task #94's
   * remove-project never touches files on disk).
   */
  app.post("/api/v1/projects/:id/subprojects/register", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const body = request.body as { relativePath?: string; name?: string } | undefined;
    if (body?.relativePath === undefined || body.relativePath === null) {
      return reply.status(400).send({ error: "relativePath is required (use \"\" for the root itself)." });
    }

    let subRoot: string;
    try {
      subRoot = body.relativePath === "" ? project.root_path : resolveWithinRoot(project.root_path, body.relativePath);
      assertValidProjectRoot(subRoot);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const existing = getProjectByRootPath(db, subRoot);
    if (existing) {
      return reply.status(409).send({ error: "A project is already registered for this path", project: existing });
    }

    const name = body.name?.trim() || path.basename(subRoot) || project.name;
    const subProject = createProject(db, randomUUID(), name, subRoot);
    return reply.status(201).send({ project: subProject });
  });

  app.post("/api/v1/projects/:id/discover", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    let result;
    try {
      result = discoverRepository(project.root_path);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const snapshot = saveDiscoverySnapshot(db, randomUUID(), id, result);
    return reply.status(200).send({ snapshot, result });
  });

  app.post("/api/v1/projects/:id/index", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    let result;
    try {
      result = indexRepository(project.root_path);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    replaceProjectFiles(db, id, result.files, randomUUID);

    return reply.status(200).send({
      totalFiles: result.totalFiles,
      testFiles: result.testFiles,
      generatedFiles: result.generatedFiles,
      indexedAt: result.indexedAt,
    });
  });

  app.get("/api/v1/projects/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const query = request.query as {
      language?: string;
      isTest?: string;
      limit?: string;
      offset?: string;
    };

    const { files, total } = listProjectFiles(db, id, {
      language: query.language,
      isTest: query.isTest !== undefined ? query.isTest === "true" : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });

    return reply.status(200).send({
      files: files.map((f) => ({ ...f, imports: f.imports ? JSON.parse(f.imports) : [] })),
      total,
    });
  });

  app.get("/api/v1/projects/:id/architecture", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const query = request.query as { depth?: string };
    const depth = query.depth ? Number(query.depth) : 2;
    if (!Number.isFinite(depth) || depth < 1) {
      return reply.status(400).send({ error: "depth must be a positive integer" });
    }

    const records = listAllProjectFiles(db, id);
    if (records.length === 0) {
      return reply.status(200).send({
        depth,
        nodes: [],
        edges: [],
        externalDependencies: [],
        generatedAt: new Date().toISOString(),
        empty: true,
      });
    }

    const view = buildArchitectureView(
      records.map((r) => ({
        relativePath: r.relative_path,
        language: r.language,
        loc: r.loc,
        isTest: r.is_test === 1,
        imports: r.imports ? JSON.parse(r.imports) : [],
      })),
      depth
    );

    return reply.status(200).send({ ...view, empty: false });
  });

  app.post("/api/v1/projects/:id/analysis", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const runId = randomUUID();
    const run = createAnalysisRun(db, runId, id);

    let result;
    try {
      result = runAnalysis(project.root_path);
    } catch (err) {
      finishAnalysisRun(db, runId, "failed", 0);
      return reply.status(400).send({ error: (err as Error).message });
    }

    replaceProjectFindings(db, id, result.findings, randomUUID);
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of result.findings) {
      if (f.severity in severityCounts) {
        severityCounts[f.severity as keyof typeof severityCounts]++;
      }
    }
    finishAnalysisRun(db, runId, "completed", result.findings.length, severityCounts);

    return reply.status(200).send({
      run: { ...run, status: "completed", findings_count: result.findings.length },
      findingsCount: result.findings.length,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    });
  });

  app.get("/api/v1/projects/:id/findings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const query = request.query as {
      severity?: string;
      category?: string;
      limit?: string;
      offset?: string;
    };

    const { findings, total } = listFindings(db, id, {
      severity: query.severity,
      category: query.category,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });

    const latestRun = getLatestAnalysisRun(db, id);

    return reply.status(200).send({ findings, total, latestRun: latestRun ?? null });
  });

  /**
   * Analysis-run history, oldest first — real data behind the Dashboard's
   * findings-trend-over-time chart. Runs from before migration 013 (or any
   * failed run) carry `null` severity counts; the frontend renders those
   * points as gaps rather than a fabricated zero.
   */
  app.get("/api/v1/projects/:id/analysis/history", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    return reply.status(200).send({ runs: listAnalysisRuns(db, id) });
  });

  const DEFAULT_CONTEXT_BUDGET_TOKENS = 4000;

  app.get("/api/v1/projects/:id/findings/:findingId/context", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const query = request.query as { budgetTokens?: string };
    const budgetTokens = query.budgetTokens ? Number(query.budgetTokens) : DEFAULT_CONTEXT_BUDGET_TOKENS;
    if (!Number.isFinite(budgetTokens) || budgetTokens < 1) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    const bundle = selectContextForFinding({
      root: project.root_path,
      finding: {
        id: finding.id,
        filePath: finding.file_path ?? "",
        lineStart: finding.line_start,
        lineEnd: finding.line_end,
      },
      files,
      budgetTokens,
    });

    return reply.status(200).send(bundle);
  });

  /**
   * Returns the most recent successful AI explanation on file for a finding,
   * if any — a read-only lookup that never calls a provider or spends
   * tokens, so the Findings page can show a previously-generated
   * explanation without re-requesting it.
   */
  app.get("/api/v1/projects/:id/findings/:findingId/explanation", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const response = getLatestSuccessfulResponse(db, findingId, EXPLAIN_FINDING_OPERATION_TYPE);
    if (!response) {
      return reply.status(200).send({ explanation: null });
    }
    return reply.status(200).send({
      explanation: response.content,
      provider: response.provider,
      model: response.model,
      generatedAt: response.requestCreatedAt,
    });
  });

  /**
   * Phase 14's first real AI call: builds a Phase 13 context bundle for the
   * finding and asks the configured provider to explain it (why it matters,
   * likely cause). This is the only route in the product so far that
   * spends real tokens against a real provider — it only runs on an
   * explicit POST from the UI, never automatically, per docs/AI_MODE.md §1's
   * "no AI action auto-executes" rule. Read-only: never writes to the
   * finding or applies anything.
   */
  app.post("/api/v1/projects/:id/findings/:findingId/explain", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await explainFinding({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      return reply.status(200).send({
        explanation: result.explanation,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  /**
   * Read-only lookup of the most recent successful root-cause analysis on
   * file for a finding — reparses the stored raw response into
   * evidence/inference/confidence on every fetch (rather than persisting
   * the parsed shape) so a change to `parseRootCauseSections` benefits
   * old rows automatically, and never calls a provider.
   */
  app.get("/api/v1/projects/:id/findings/:findingId/root-cause", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const response = getLatestSuccessfulResponse(db, findingId, ROOT_CAUSE_ANALYSIS_OPERATION_TYPE);
    if (!response) {
      return reply.status(200).send({ analysis: null });
    }
    return reply.status(200).send({
      analysis: parseRootCauseSections(response.content ?? ""),
      provider: response.provider,
      model: response.model,
      generatedAt: response.requestCreatedAt,
    });
  });

  /**
   * Phase 15's AI call: builds a Phase 13 context bundle for the finding
   * and asks the configured provider to separate evidence from inference
   * (docs/AI_MODE.md §4's "Root Cause Analysis" workflow step) — like
   * `/explain`, only runs on an explicit POST, never automatically.
   * Read-only: never writes to the finding or applies anything.
   */
  app.post("/api/v1/projects/:id/findings/:findingId/root-cause", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await analyzeRootCause({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      return reply.status(200).send({
        analysis: result.analysis,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  /**
   * Read-only lookup of the most recent successful fix plan on file for a
   * finding — like `/root-cause`, reparses the stored raw response into
   * its seven sections on every fetch rather than persisting the parsed
   * shape, and never calls a provider.
   */
  app.get("/api/v1/projects/:id/findings/:findingId/fix-plan", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const response = getLatestSuccessfulResponse(db, findingId, FIX_PLAN_OPERATION_TYPE);
    if (!response) {
      return reply.status(200).send({ plan: null });
    }
    return reply.status(200).send({
      plan: parseFixPlanSections(response.content ?? ""),
      provider: response.provider,
      model: response.model,
      generatedAt: response.requestCreatedAt,
    });
  });

  /**
   * Phase 16's AI call: builds the seven-section fix plan docs/AI_MODE.md
   * §5 defines, folding in a prior Phase 15 root-cause analysis for this
   * finding as grounding when one exists. Like `/explain` and
   * `/root-cause`, only runs on an explicit POST, never automatically.
   * Strictly advisory: this produces words describing a proposed change,
   * never a diff and never anything applied to disk — patch generation
   * (Phase 17) is a separate, later, human-approval-gated workflow.
   */
  app.post("/api/v1/projects/:id/findings/:findingId/fix-plan", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await planFix({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      return reply.status(200).send({
        plan: result.plan,
        usedPriorRootCauseAnalysis: result.usedPriorRootCauseAnalysis,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  // --- "Fix all findings" (Pro tier only) -----------------------------------
  //
  // Per the user's explicit request: a bulk action on the Findings page that
  // runs the plan → create patch → approve → generate-diff pipeline for
  // every findable-but-not-yet-patched finding in one call, gated to Pro
  // subscribers (checkAiOperationAllowed's `tier` — the same field the
  // Billing page already reads). Still stops at a real diff ('proposed'
  // status): the second human-approval gate (approve-apply) and the actual
  // disk write (/apply, or the download-zip flow) are deliberately left
  // fully manual, same as every single-finding patch — this automates away
  // the repetitive "generate a plan, create a patch, approve it, generate
  // the diff" clicking, not the actual "let this touch my files" decision.
  const FIX_ALL_MAX_FINDINGS = 50; // safety cap — see the `skipped` field in the response for anything left over

  app.post("/api/v1/projects/:id/findings/fix-all", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const usageCheck = checkAiOperationAllowed(db);
    if (usageCheck.tier !== "pro") {
      return reply
        .status(403)
        .send({ error: "Fixing all findings at once is a Pro-tier feature. Upgrade to Pro in Settings to use it." });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;
    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    // Only findings with no existing non-rejected patch — a finding someone
    // already started (or finished) fixing individually isn't re-fixed or
    // duplicated by this bulk action.
    const { findings: allFindings } = listFindings(db, id, {});
    const eligible = allFindings.filter(
      (f) => !listPatchesForFinding(db, f.id).some((p) => p.status !== "rejected")
    );
    const targeted = eligible.slice(0, FIX_ALL_MAX_FINDINGS);
    const skipped = eligible.length - targeted.length;

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    const providerConfig = {
      id: providerRecord.id,
      name: providerRecord.name,
      kind: providerRecord.kind,
      baseUrl: providerRecord.base_url,
      model: providerRecord.model,
      apiKey: providerRecord.api_key,
    };

    let promptTokens = 0;
    let completionTokens = 0;
    const results: Array<{ findingId: string; patchId: string | null; error: string | null }> = [];

    // Sequential, not parallel: each iteration is two real AI calls against
    // the same provider, and running dozens of these concurrently would
    // just as likely trip the provider's own rate limit as this app's
    // usage cap — a bulk action failing halfway with a clear per-finding
    // error list is a far better experience than a burst of simultaneous
    // 429s. `results` lets the frontend show exactly what happened to each
    // finding even though this loop keeps going after a single failure.
    for (const finding of targeted) {
      try {
        const planResult = await planFix({
          db,
          projectId: id,
          projectRoot: project.root_path,
          finding,
          files,
          providerConfig,
          budgetTokens: body?.budgetTokens,
        });
        promptTokens += planResult.usage.promptTokens ?? 0;
        completionTokens += planResult.usage.completionTokens ?? 0;

        const patch = createPatch(db, randomUUID(), {
          projectId: id,
          findingId: finding.id,
          description: planResult.plan.problem ?? null,
        });
        createPatchReview(db, randomUUID(), {
          patchId: patch.id,
          decision: "approved_for_generation",
          reviewerNote: "Approved automatically by \"Fix all findings\" (Pro).",
        });
        updatePatchStatus(db, patch.id, "approved");

        const patchResult = await generatePatch({
          db,
          projectId: id,
          projectRoot: project.root_path,
          finding,
          files,
          providerConfig,
          budgetTokens: body?.budgetTokens,
        });
        promptTokens += patchResult.usage.promptTokens ?? 0;
        completionTokens += patchResult.usage.completionTokens ?? 0;
        setPatchDiff(db, patch.id, patchResult.diffText, "proposed");

        results.push({ findingId: finding.id, patchId: patch.id, error: null });
      } catch (err) {
        const message =
          err instanceof AIProviderError
            ? err.message
            : err instanceof Error
              ? err.message
              : "AI provider request failed.";
        results.push({ findingId: finding.id, patchId: null, error: message });
      }
    }

    return reply.status(200).send({
      attempted: targeted.length,
      succeeded: results.filter((r) => r.error === null).length,
      failed: results.filter((r) => r.error !== null).length,
      skipped,
      results,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });
  });

  // --- Phase 17: patch generation (diff, human-approved) -------------------
  //
  // The first phase to produce anything that could eventually change a file
  // on disk — so, unlike /explain, /root-cause, and /fix-plan, this isn't a
  // single request/response call. It's a real, persisted state machine
  // (backend/src/db/patchRepo.ts) enforcing docs/AI_MODE.md §4's first
  // human-approval gate ("Human Approval → Patch Generation") server-side:
  // a patch is created in 'pending_approval' with no diff yet, must be
  // explicitly approved via its own request before /generate will do
  // anything, and /generate itself never writes to any file — it only ever
  // updates the patch row's diff_text and status. Applying an approved,
  // reviewed diff to disk is Phase 18, below.

  /** Creates a patch registration (no diff yet) for a finding that already has a fix plan. */
  app.post("/api/v1/projects/:id/findings/:findingId/patches", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const fixPlanResponse = getLatestSuccessfulResponse(db, findingId, FIX_PLAN_OPERATION_TYPE);
    if (!fixPlanResponse) {
      return reply.status(400).send({ error: "Generate a fix plan for this finding first." });
    }

    const body = request.body as { description?: string } | undefined;
    const description = body?.description ?? parseFixPlanSections(fixPlanResponse.content ?? "").problem;

    const patch = createPatch(db, randomUUID(), { projectId: id, findingId, description: description ?? null });
    return reply.status(201).send({ patch });
  });

  app.get("/api/v1/projects/:id/findings/:findingId/patches", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    return reply.status(200).send({ patches: listPatchesForFinding(db, findingId) });
  });

  app.get("/api/v1/projects/:id/patches/:patchId", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }

    return reply.status(200).send({ patch });
  });

  /** The first human-approval gate: a patch must be approved here before /generate will act on it. */
  app.post("/api/v1/projects/:id/patches/:patchId/approve", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "pending_approval") {
      return reply.status(400).send({ error: `Patch is "${patch.status}", not "pending_approval" — cannot approve.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createPatchReview(db, randomUUID(), {
      patchId,
      decision: "approved_for_generation",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updatePatchStatus(db, patchId, "approved");

    return reply.status(200).send({ patch: getPatchById(db, patchId) });
  });

  app.post("/api/v1/projects/:id/patches/:patchId/reject", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "pending_approval") {
      return reply.status(400).send({ error: `Patch is "${patch.status}", not "pending_approval" — cannot reject.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createPatchReview(db, randomUUID(), {
      patchId,
      decision: "rejected_before_generation",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updatePatchStatus(db, patchId, "rejected");

    return reply.status(200).send({ patch: getPatchById(db, patchId) });
  });

  /**
   * The only route that actually calls a provider to produce diff text —
   * requires the patch to already be 'approved' (checked against the
   * persisted state, not a request flag), so a client cannot skip the
   * approval step by omitting it from this call's body.
   */
  app.post("/api/v1/projects/:id/patches/:patchId/generate", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "approved") {
      return reply.status(400).send({
        error: `Patch is "${patch.status}", not "approved" — approve it first via POST .../approve before generating.`,
      });
    }
    if (!patch.finding_id) {
      return reply.status(400).send({ error: "Patch has no associated finding." });
    }
    const finding = getFindingById(db, patch.finding_id);
    if (!finding) {
      return reply.status(404).send({ error: "The patch's finding no longer exists." });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await generatePatch({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      setPatchDiff(db, patchId, result.diffText, "proposed");

      return reply.status(200).send({
        patch: getPatchById(db, patchId),
        usedFixPlan: result.usedFixPlan,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  // --- "Approve & generate all" (Pro tier only) -----------------------------
  //
  // The Changes page's bulk counterpart to /findings/fix-all: instead of
  // starting from findings, this operates on patches that already exist in
  // 'pending_approval' (created individually, or by a prior fix-plan run)
  // and runs the approve → generate-diff step for each, so a Pro user
  // doesn't have to click "Approve" then "Generate" per row in the queue.
  // Same Pro gate, same real per-item usage totals, same deliberate stop
  // short of the second gate (approve-apply / actual disk write).
  const GENERATE_ALL_MAX_PATCHES = 50;

  app.post("/api/v1/projects/:id/patches/generate-all", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const usageCheck = checkAiOperationAllowed(db);
    if (usageCheck.tier !== "pro") {
      return reply
        .status(403)
        .send({ error: "Approving and generating all patches at once is a Pro-tier feature. Upgrade to Pro in Settings to use it." });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;
    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const pending = listPatchesForProject(db, id).filter((p) => p.status === "pending_approval");
    const targeted = pending.slice(0, GENERATE_ALL_MAX_PATCHES);
    const skipped = pending.length - targeted.length;

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    const providerConfig = {
      id: providerRecord.id,
      name: providerRecord.name,
      kind: providerRecord.kind,
      baseUrl: providerRecord.base_url,
      model: providerRecord.model,
      apiKey: providerRecord.api_key,
    };

    let promptTokens = 0;
    let completionTokens = 0;
    const results: Array<{ patchId: string; error: string | null }> = [];

    for (const patch of targeted) {
      try {
        if (!patch.finding_id) throw new Error("Patch has no associated finding.");
        const finding = getFindingById(db, patch.finding_id);
        if (!finding) throw new Error("The patch's finding no longer exists.");

        createPatchReview(db, randomUUID(), {
          patchId: patch.id,
          decision: "approved_for_generation",
          reviewerNote: "Approved automatically by \"Approve & generate all\" (Pro).",
        });
        updatePatchStatus(db, patch.id, "approved");

        const patchResult = await generatePatch({
          db,
          projectId: id,
          projectRoot: project.root_path,
          finding,
          files,
          providerConfig,
          budgetTokens: body?.budgetTokens,
        });
        promptTokens += patchResult.usage.promptTokens ?? 0;
        completionTokens += patchResult.usage.completionTokens ?? 0;
        setPatchDiff(db, patch.id, patchResult.diffText, "proposed");

        results.push({ patchId: patch.id, error: null });
      } catch (err) {
        const message =
          err instanceof AIProviderError
            ? err.message
            : err instanceof Error
              ? err.message
              : "AI provider request failed.";
        results.push({ patchId: patch.id, error: message });
      }
    }

    return reply.status(200).send({
      attempted: targeted.length,
      succeeded: results.filter((r) => r.error === null).length,
      failed: results.filter((r) => r.error !== null).length,
      skipped,
      results,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });
  });

  // --- Phase 18: diff review, second human-approval gate, and apply --------
  //
  // docs/AI_MODE.md §4's second gate: "Diff Review → Human Approval →
  // Apply Patch". A 'proposed' patch (has a real diff, from Phase 17) must
  // be explicitly approved again — reviewing the diff is a separate
  // decision from approving that generation should happen at all — before
  // /apply will touch any file. /apply is the first route in this product
  // that writes to disk: it always runs a real `git apply --check` dry run
  // first (backend/src/patch/applyPatch.ts) and only performs the real
  // write if that dry run succeeds, so a diff that no longer applies
  // cleanly (e.g. the file changed since generation) fails loudly with the
  // real `git apply` error rather than partially writing or guessing.

  /** The second human-approval gate: a diff must be approved here before /apply will act on it. */
  app.post("/api/v1/projects/:id/patches/:patchId/approve-apply", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "proposed") {
      return reply.status(400).send({ error: `Patch is "${patch.status}", not "proposed" — cannot approve for apply.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createPatchReview(db, randomUUID(), {
      patchId,
      decision: "approved_for_apply",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updatePatchStatus(db, patchId, "approved_for_apply");

    return reply.status(200).send({ patch: getPatchById(db, patchId) });
  });

  /**
   * Also accepts 'approved_for_apply', not just 'proposed' — a real gap the
   * user hit: once a diff passed the second approval gate, there was no way
   * back except actually applying it. A reviewer can legitimately change
   * their mind after approving-for-apply but before the real disk write
   * (e.g. they re-read the diff, or new commits landed on the file since)
   * — this route is the only thing standing between that decision and an
   * unwanted `git apply`, so it needs to stay reachable right up until
   * /apply actually runs, not just from one specific prior status.
   */
  app.post("/api/v1/projects/:id/patches/:patchId/reject-apply", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "proposed" && patch.status !== "approved_for_apply") {
      return reply
        .status(400)
        .send({ error: `Patch is "${patch.status}", not "proposed" or "approved_for_apply" — cannot reject.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createPatchReview(db, randomUUID(), {
      patchId,
      decision: "rejected_after_review",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updatePatchStatus(db, patchId, "rejected");

    return reply.status(200).send({ patch: getPatchById(db, patchId) });
  });

  /**
   * Pro-tier bulk counterpart to /reject-apply: rejects every patch on this
   * project that's still awaiting a human decision past the diff-review
   * gate ('proposed' or 'approved_for_apply'), in one call. Unlike
   * fix-all/generate-all this never calls an AI provider — it's a pure DB
   * state change — so there's no usage/token total to report, and it's
   * gated on Pro tier purely because bulk-rejecting a whole queue at once
   * is a power-user action, same reasoning as the other "…all" buttons.
   */
  app.post("/api/v1/projects/:id/patches/reject-all", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const usageCheck = checkAiOperationAllowed(db);
    if (usageCheck.tier !== "pro") {
      return reply
        .status(403)
        .send({ error: "Rejecting all patches at once is a Pro-tier feature. Upgrade to Pro in Settings to use it." });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    const targeted = listPatchesForProject(db, id).filter(
      (p) => p.status === "proposed" || p.status === "approved_for_apply"
    );

    for (const patch of targeted) {
      createPatchReview(db, randomUUID(), {
        patchId: patch.id,
        decision: "rejected_after_review",
        reviewerNote: body?.reviewerNote ?? "Rejected in bulk via \"Reject all\" (Pro).",
      });
      updatePatchStatus(db, patch.id, "rejected");
    }

    return reply.status(200).send({
      attempted: targeted.length,
      succeeded: targeted.length,
      failed: 0,
      skipped: 0,
      results: targeted.map((p) => ({ patchId: p.id, error: null })),
    });
  });

  /**
   * The only route in this product that writes to a file on disk. Requires
   * the patch to already be 'approved_for_apply' (checked against the
   * persisted state) — or 'failed', so a mechanical apply failure (e.g.
   * transient drift) can be retried without re-litigating the human
   * decision that the change itself is worth applying. A failed dry run
   * or real apply never throws — it's a normal, informative outcome
   * (same convention as the Free Mode test runner reporting a failed
   * test run), so this returns 200 with status 'failed' and the real
   * `git apply` error in `apply_error`, not an HTTP error status.
   */
  app.post("/api/v1/projects/:id/patches/:patchId/apply", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (patch.status !== "approved_for_apply" && patch.status !== "failed") {
      return reply.status(400).send({
        error: `Patch is "${patch.status}", not "approved_for_apply" — review and approve the diff first via POST .../approve-apply before applying.`,
      });
    }
    if (!patch.diff_text) {
      return reply.status(400).send({ error: "Patch has no diff to apply." });
    }
    // Task #90: a project set to "download" mode never gets a direct write
    // here — the patch stays exactly as approved (still retryable once the
    // setting is switched back), and the caller is pointed at the zip
    // download route instead.
    if (project.apply_mode === "download") {
      return reply.status(400).send({
        error:
          'This project is set to download changes as a zip instead of applying them directly (see Settings). Use GET .../download-zip, or switch applyMode to "direct" first.',
      });
    }

    const result = applyPatchToDisk(project.root_path, patch.diff_text);
    setPatchApplyResult(db, patchId, result.success ? "applied" : "failed", result.error);

    return reply.status(200).send({ patch: getPatchById(db, patchId) });
  });

  /**
   * Task #90: downloads the patched file(s) as a zip instead of writing
   * them to the project's real files — the counterpart to the direct
   * `/apply` route above, always available regardless of `apply_mode`
   * (useful even in "direct" mode, e.g. to inspect a change before
   * approving it for real). Requires a real diff to exist (any status from
   * `proposed` onward) but does not require or change the patch's approval
   * status — downloading a zip is read-only from the patch's own
   * state-machine perspective, same as `/self-review`.
   */
  app.get("/api/v1/projects/:id/patches/:patchId/download-zip", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (!patch.diff_text) {
      return reply.status(400).send({ error: "Patch has no diff yet — generate one first via POST .../generate." });
    }

    let zipBuffer: Buffer;
    try {
      zipBuffer = buildPatchZip(project.root_path, patch.diff_text);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    return reply
      .status(200)
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="patch-${patchId}.zip"`)
      .send(zipBuffer);
  });

  /**
   * Read-only lookup of the most recent successful self-review on file
   * for a patch — like `/findings/:findingId/root-cause`, reparses the
   * stored raw response into its seven checks on every fetch rather than
   * persisting the parsed shape, and never calls a provider.
   */
  app.get("/api/v1/projects/:id/patches/:patchId/self-review", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }

    const response = getLatestSuccessfulResponseForPatch(db, patchId, SELF_REVIEW_OPERATION_TYPE);
    if (!response) {
      return reply.status(200).send({ review: null });
    }
    return reply.status(200).send({
      review: parseSelfReviewSections(response.content ?? ""),
      provider: response.provider,
      model: response.model,
      generatedAt: response.requestCreatedAt,
    });
  });

  /**
   * Phase 21's AI call: docs/AI_MODE.md §6's self-review checklist, run
   * against a real patch's real diff. Advisory only — this never changes
   * the patch's `status` and is never a precondition for `/approve-apply`
   * or `/apply`; it can be requested at any point once the patch has a
   * real `diff_text` (any status past `proposed`), including more than
   * once for the same diff. Read-only in the sense that matters for this
   * product's security model: never writes to the finding, the patch
   * record's status, or any file.
   */
  app.post("/api/v1/projects/:id/patches/:patchId/self-review", async (request, reply) => {
    const { id, patchId } = request.params as { id: string; patchId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const patch = getPatchById(db, patchId);
    if (!patch || patch.project_id !== id) {
      return reply.status(404).send({ error: "Patch not found" });
    }
    if (!patch.diff_text) {
      return reply.status(400).send({ error: "Patch has no diff yet — generate one first via POST .../generate." });
    }
    if (!patch.finding_id) {
      return reply.status(400).send({ error: "Patch has no associated finding to ground the self-review in." });
    }
    const finding = getFindingById(db, patch.finding_id);
    if (!finding) {
      return reply.status(404).send({ error: "Patch's finding not found." });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await selfReviewPatch({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        patch,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      return reply.status(200).send({
        review: result.review,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  // --- Phase 19: AI test generation (reviewed & executed) -------------------
  //
  // docs/AI_MODE.md §1: "AI-generated tests (reviewed & executed, not
  // trusted on compile alone)". Mirrors Phases 17-18's two-gate shape —
  // registering intent never calls a provider, generating never writes a
  // file, and writing a file always runs the real Phase 9 test command
  // afterward rather than trusting the AI's code just because it parses.
  // Unlike patch generation/apply, this only ever creates a NEW file —
  // /write-and-run refuses to touch a path that already exists, so there
  // is nothing to dry-run against and no "drifted since generation" case.

  /** Creates a generated-test registration (no code yet) for a finding. */
  app.post("/api/v1/projects/:id/findings/:findingId/generated-tests", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    const body = request.body as { description?: string } | undefined;
    const generatedTest = createGeneratedTest(db, randomUUID(), {
      projectId: id,
      findingId,
      description: body?.description ?? null,
    });
    return reply.status(201).send({ generatedTest });
  });

  app.get("/api/v1/projects/:id/findings/:findingId/generated-tests", async (request, reply) => {
    const { id, findingId } = request.params as { id: string; findingId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const finding = getFindingById(db, findingId);
    if (!finding || finding.project_id !== id) {
      return reply.status(404).send({ error: "Finding not found" });
    }

    return reply.status(200).send({ generatedTests: listGeneratedTestsForFinding(db, findingId) });
  });

  app.get("/api/v1/projects/:id/generated-tests/:testId", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }

    return reply.status(200).send({ generatedTest });
  });

  /** The first human-approval gate: must be approved here before /generate will act on it. */
  app.post("/api/v1/projects/:id/generated-tests/:testId/approve", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    if (generatedTest.status !== "pending_approval") {
      return reply.status(400).send({ error: `Generated test is "${generatedTest.status}", not "pending_approval" — cannot approve.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createGeneratedTestReview(db, randomUUID(), {
      generatedTestId: testId,
      decision: "approved_for_generation",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updateGeneratedTestStatus(db, testId, "approved");

    return reply.status(200).send({ generatedTest: getGeneratedTestById(db, testId) });
  });

  app.post("/api/v1/projects/:id/generated-tests/:testId/reject", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    if (generatedTest.status !== "pending_approval") {
      return reply.status(400).send({ error: `Generated test is "${generatedTest.status}", not "pending_approval" — cannot reject.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createGeneratedTestReview(db, randomUUID(), {
      generatedTestId: testId,
      decision: "rejected_before_generation",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updateGeneratedTestStatus(db, testId, "rejected");

    return reply.status(200).send({ generatedTest: getGeneratedTestById(db, testId) });
  });

  /** The only route that calls a provider to produce test code — requires the registration to already be 'approved'. */
  app.post("/api/v1/projects/:id/generated-tests/:testId/generate", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    if (generatedTest.status !== "approved") {
      return reply.status(400).send({
        error: `Generated test is "${generatedTest.status}", not "approved" — approve it first via POST .../approve before generating.`,
      });
    }
    if (!generatedTest.finding_id) {
      return reply.status(400).send({ error: "Generated test has no associated finding." });
    }
    const finding = getFindingById(db, generatedTest.finding_id);
    if (!finding) {
      return reply.status(404).send({ error: "The generated test's finding no longer exists." });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await generateTest({
        db,
        projectId: id,
        projectRoot: project.root_path,
        finding,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      setGeneratedTestContent(db, testId, result.data.targetPath, result.data.testCode, "proposed");

      return reply.status(200).send({
        generatedTest: getGeneratedTestById(db, testId),
        usedFixPlan: result.usedFixPlan,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  /** The second human-approval gate: the generated code must be approved here before /write-and-run will act on it. */
  app.post("/api/v1/projects/:id/generated-tests/:testId/approve-write", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    if (generatedTest.status !== "proposed") {
      return reply.status(400).send({ error: `Generated test is "${generatedTest.status}", not "proposed" — cannot approve for write.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createGeneratedTestReview(db, randomUUID(), {
      generatedTestId: testId,
      decision: "approved_for_write",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updateGeneratedTestStatus(db, testId, "approved_for_write");

    return reply.status(200).send({ generatedTest: getGeneratedTestById(db, testId) });
  });

  app.post("/api/v1/projects/:id/generated-tests/:testId/reject-write", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    if (generatedTest.status !== "proposed") {
      return reply.status(400).send({ error: `Generated test is "${generatedTest.status}", not "proposed" — cannot reject.` });
    }

    const body = request.body as { reviewerNote?: string } | undefined;
    createGeneratedTestReview(db, randomUUID(), {
      generatedTestId: testId,
      decision: "rejected_after_review",
      reviewerNote: body?.reviewerNote ?? null,
    });
    updateGeneratedTestStatus(db, testId, "rejected");

    return reply.status(200).send({ generatedTest: getGeneratedTestById(db, testId) });
  });

  /**
   * The only route in this feature that writes to a file on disk — and,
   * unlike Phase 18's patch apply, also executes it. Requires the
   * generated test to be 'approved_for_write' (or a prior 'written' /
   * 'failed_tests' / 'passed' outcome, so re-running after e.g. fixing an
   * unrelated failure elsewhere doesn't require re-approving the same
   * code). Refuses to overwrite an existing file — this feature only
   * ever creates new test files. Always runs the project's real,
   * existing test command (Phase 9) afterward and persists a real
   * `test_run` row, so nothing here is "trusted on compile alone".
   */
  app.post("/api/v1/projects/:id/generated-tests/:testId/write-and-run", async (request, reply) => {
    const { id, testId } = request.params as { id: string; testId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const generatedTest = getGeneratedTestById(db, testId);
    if (!generatedTest || generatedTest.project_id !== id) {
      return reply.status(404).send({ error: "Generated test not found" });
    }
    const retryableStatuses = ["approved_for_write", "written", "failed_tests", "passed"];
    if (!retryableStatuses.includes(generatedTest.status)) {
      return reply.status(400).send({
        error: `Generated test is "${generatedTest.status}", not "approved_for_write" — review and approve the code first via POST .../approve-write before writing.`,
      });
    }
    if (!generatedTest.target_path || !generatedTest.test_code) {
      return reply.status(400).send({ error: "Generated test has no target path or code to write." });
    }

    let absTarget: string;
    try {
      absTarget = resolveWithinRoot(project.root_path, generatedTest.target_path);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return reply.status(400).send({ error: "The AI-proposed test path escapes the project root — refusing to write it." });
      }
      throw err;
    }

    // Only ever creates a new file — never overwrites anything already on disk,
    // whether that's a real file the human cares about or a leftover from a
    // previous run of this same generated test at the same path.
    const alreadyExisted = fs.existsSync(absTarget);
    if (!alreadyExisted) {
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, generatedTest.test_code, "utf-8");
    } else if (generatedTest.status === "approved_for_write") {
      // First attempt for this generated test, but something is already there — refuse.
      return reply.status(400).send({
        error: `A file already exists at "${generatedTest.target_path}" — AI test generation only creates new test files, it never overwrites one.`,
      });
    }
    // else: this is a retry of a generated test that already wrote its own
    // file on a prior attempt (status written/failed_tests/passed) — the
    // file existing is expected, not a conflict; just re-run the suite.

    const outcome = await runTests(project.root_path);
    const testRunId = randomUUID();
    const testRun = saveTestRun(db, testRunId, id, outcome);

    const status = !outcome.supported ? "written" : outcome.exitCode === 0 ? "passed" : "failed_tests";
    setGeneratedTestRunResult(db, testId, status, testRunId);

    return reply.status(200).send({
      generatedTest: getGeneratedTestById(db, testId),
      testRun,
      supported: outcome.supported,
      reason: outcome.reason,
    });
  });

  app.get("/api/v1/projects/:id/git", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const query = request.query as { commitLimit?: string; churnDays?: string };
    const commitLimit = query.commitLimit ? Number(query.commitLimit) : undefined;
    if (commitLimit !== undefined && (!Number.isFinite(commitLimit) || commitLimit < 1)) {
      return reply.status(400).send({ error: "commitLimit must be a positive integer" });
    }
    const churnWindowDays = query.churnDays ? Number(query.churnDays) : undefined;
    if (churnWindowDays !== undefined && (!Number.isFinite(churnWindowDays) || churnWindowDays < 1)) {
      return reply.status(400).send({ error: "churnDays must be a positive integer" });
    }

    const result = analyzeGit(project.root_path, { commitLimit, churnWindowDays });
    return reply.status(200).send(result);
  });

  app.post("/api/v1/projects/:id/tests/run", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    // Synchronous, bounded by runTests' internal timeout — same pattern as
    // POST /analysis (Phase 6/7), not a background job queue. Test suites
    // in this product's supported frameworks (Vitest, Maven) normally
    // finish in seconds to low minutes; the timeout exists to bound the
    // worst case, not because this is expected to be slow.
    const outcome = await runTests(project.root_path);
    const runId = randomUUID();
    const run = saveTestRun(db, runId, id, outcome);

    return reply.status(200).send({ run, supported: outcome.supported, reason: outcome.reason });
  });

  app.get("/api/v1/projects/:id/tests", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : undefined;
    const runs = listTestRuns(db, id, limit);
    return reply.status(200).send({ runs });
  });

  app.get("/api/v1/projects/:id/tests/:runId", async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const run = getTestRun(db, runId);
    if (!run || run.project_id !== id) {
      return reply.status(404).send({ error: "Test run not found" });
    }
    return reply.status(200).send({ run });
  });

  /** Deletes one entry from the Tests page's run history. Only the recorded run is removed — the real test suite on disk is never touched, and this never re-runs anything. */
  app.delete("/api/v1/projects/:id/tests/:runId", async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const run = getTestRun(db, runId);
    if (!run || run.project_id !== id) {
      return reply.status(404).send({ error: "Test run not found" });
    }

    deleteTestRun(db, runId);
    return reply.status(200).send({ deleted: true });
  });

  /** Pro-tier only: clears the entire run history for a project in one call, per the user's explicit request ("delete tests and delete all (PRO only)"). */
  app.delete("/api/v1/projects/:id/tests", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const usageCheck = checkAiOperationAllowed(db);
    if (usageCheck.tier !== "pro") {
      return reply
        .status(403)
        .send({ error: "Deleting all test run history at once is a Pro-tier feature. Upgrade to Pro in Settings to use it." });
    }

    const deleted = deleteAllTestRuns(db, id);
    return reply.status(200).send({ deleted });
  });

  /**
   * Read-only lookup of the most recent successful failure diagnosis on
   * file for a test run — like `/findings/:findingId/root-cause`,
   * reparses the stored raw response into its three sections on every
   * fetch rather than persisting the parsed shape, and never calls a
   * provider.
   */
  app.get("/api/v1/projects/:id/tests/:runId/diagnosis", async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const run = getTestRun(db, runId);
    if (!run || run.project_id !== id) {
      return reply.status(404).send({ error: "Test run not found" });
    }

    const response = getLatestSuccessfulResponseForTestRun(db, runId, FAILURE_DIAGNOSIS_OPERATION_TYPE);
    if (!response) {
      return reply.status(200).send({ diagnosis: null });
    }
    return reply.status(200).send({
      diagnosis: parseFailureDiagnosisSections(response.content ?? ""),
      provider: response.provider,
      model: response.model,
      generatedAt: response.requestCreatedAt,
    });
  });

  /**
   * Phase 20's AI call: docs/AI_MODE.md §4's "(if failure) AI Diagnosis"
   * workflow step. Only callable for a run whose `status` is `failed` —
   * a passed, timed-out, or unsupported run has nothing to diagnose in
   * this sense (a timeout or "no test command found" isn't a test
   * failure to explain, it's a different kind of problem entirely).
   * Read-only: never writes to the test run or proposes an applied
   * change, same as `/findings/:findingId/root-cause`.
   */
  app.post("/api/v1/projects/:id/tests/:runId/diagnose", async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const run = getTestRun(db, runId);
    if (!run || run.project_id !== id) {
      return reply.status(404).send({ error: "Test run not found" });
    }
    if (run.status !== "failed") {
      return reply.status(400).send({ error: `Only a run with status 'failed' can be diagnosed (this run's status is '${run.status}').` });
    }

    const body = request.body as { providerId?: string; budgetTokens?: number } | undefined;

    const resolved = resolveEnabledProvider(db, body);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }
    const providerRecord = resolved.provider;

    if (body?.budgetTokens !== undefined && (!Number.isFinite(body.budgetTokens) || body.budgetTokens < 1)) {
      return reply.status(400).send({ error: "budgetTokens must be a positive integer" });
    }

    const files = listAllProjectFiles(db, id).map((f) => ({
      relativePath: f.relative_path,
      language: f.language,
      imports: f.imports ? (JSON.parse(f.imports) as string[]) : [],
      isTest: f.is_test === 1,
    }));

    try {
      const result = await diagnoseFailure({
        db,
        projectId: id,
        projectRoot: project.root_path,
        testRun: run,
        files,
        providerConfig: {
          id: providerRecord.id,
          name: providerRecord.name,
          kind: providerRecord.kind,
          baseUrl: providerRecord.base_url,
          model: providerRecord.model,
          apiKey: providerRecord.api_key,
        },
        budgetTokens: body?.budgetTokens,
      });

      return reply.status(200).send({
        diagnosis: result.diagnosis,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        contextBundle: result.bundle,
      });
    } catch (err) {
      if (err instanceof AIProviderError) {
        const status = err.kind === "auth_error" ? 401 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message, kind: err.kind });
      }
      return reply.status(502).send({ error: err instanceof Error ? err.message : "AI provider request failed." });
    }
  });

  app.get("/api/v1/projects/:id/security", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const result = scanSecurity(project.root_path);
    return reply.status(200).send(result);
  });

  app.get("/api/v1/projects/:id/dependencies", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const result = analyzeDependencies(project.root_path);
    return reply.status(200).send(result);
  });

  app.get("/api/v1/projects/:id/audit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const report = buildAuditReport(db, project);
    return reply.status(200).send(report);
  });

  app.get("/api/v1/projects/:id/audit/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const report = buildAuditReport(db, project);
    const markdown = buildAuditMarkdown(report);
    const filename = `${project.name.replace(/[^a-z0-9_-]+/gi, "_")}-audit-${report.generatedAt.slice(0, 10)}.md`;

    return reply
      .status(200)
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(markdown);
  });

  // --- Changes (unified review queue) --------------------------------
  //
  // Everything above this point that touches `patch`/`generated_test` is
  // scoped to a single finding (`listPatchesForFinding` etc.) — the right
  // shape for the Findings page's inline per-finding review UI. The
  // Changes page needs the opposite: every patch and generated test for
  // the *whole project*, regardless of which finding produced it, so a
  // reviewer can work through one queue instead of hunting through every
  // finding for anything left pending. `listPatchesForProject` /
  // `listGeneratedTestsForProject` (added alongside this route) already do
  // that aggregation at the SQL layer; this route just returns both lists
  // together under one response so the frontend can render one page. All
  // the existing per-item approve/reject/generate/apply routes above are
  // reused as-is for taking action on any item this route lists — this is
  // read-only, a queue view, not a new mutation surface.
  app.get("/api/v1/projects/:id/changes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = getProjectById(db, id);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    return reply.status(200).send({
      patches: listPatchesForProject(db, id),
      generatedTests: listGeneratedTestsForProject(db, id),
    });
  });
}
