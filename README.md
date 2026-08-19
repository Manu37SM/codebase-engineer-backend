# Codebase Engineer — Backend

The Fastify + TypeScript + SQLite API that powers Codebase Engineer:
repository discovery/indexing, the deterministic analysis engine,
findings, git analysis, the test runner, dependency/security analysis,
audit reports, the full AI Mode workflow (context selection through
self-review, behind a provider-agnostic interface), and the optional,
opt-in Razorpay billing/usage-limiting module.

This folder is its own git repository, separate from the project root and
from `../frontend/` — see the root [`README.md`](../README.md#version-control-layout)
for why. For product scope, architecture, security model, and full feature
status, see the docs in [`../docs/`](../docs/); this file only covers
working inside this folder.

## Requirements

Node.js 18+.

## Setup

```bash
npm install
```

On first run, the backend creates/updates a local SQLite database (see
`src/config.ts` for the resolved data directory, overridable via
`CODEBASE_ENGINEER_DATA_DIR`) and applies every pending migration from
`src/db/migrations/` through the migration runner in `src/db/index.ts`.

## Scripts

```bash
npm run dev          # start in watch mode (tsx), http://localhost:4000
npm run build         # tsc -p tsconfig.json, then copy migrations + built frontend into dist/
npm start              # node dist/server.js — run the compiled build
npm test                # vitest run — the full backend test suite
npm run typecheck        # tsc --noEmit, no build output
```

`npm run build` also copies `../frontend/dist` into `dist/public` if the
frontend has already been built (see `scripts/copy-frontend.mjs` and
[`../docs/PACKAGING.md`](../docs/PACKAGING.md)) — when present, the
compiled backend serves the built frontend itself on the same port
(`npm start`), rather than requiring a separate frontend dev server.

## Layout

```
src/
  ai/            Provider-agnostic AI Mode: context selection, workflows, provider adapters
  analysis/      Deterministic analysis rules (large-file, missing-test-file, hardcoded-secret, ...)
  architecture/  Module/dependency graph construction for the Architecture explorer
  audit/         Combined audit-report assembly (snapshot + findings + security + deps + git + tests)
  billing/       Optional, opt-in Razorpay monetization module — own DB tables, imported by nothing else
  db/            SQLite connection, migration runner, migrations/, per-entity repositories
  dependencies/  Dependency manifest parsing + duplicate-version analysis (npm/Maven)
  discovery/     Gitignore-aware file walker, language/build-system/framework detectors
  git/           Git analysis (branch, working tree, commit history, churn, diffs) — shells out to `git`
  indexer/       Per-file classification (language/LOC/size/hash/test/generated), import extraction
  patch/         AI-generated patch apply (the only route that writes to disk, human-approval gated)
  routes/        Fastify route handlers, one file per resource
  security/      Path sandboxing, secret redaction, secret pattern definitions
  services/      Cross-cutting service helpers shared across routes
  testrunner/    Real test-command detection + execution (npm/pnpm/yarn/mvn), with timeout/tree-kill
  server.ts      Process entrypoint
  app.ts         buildApp() — assembles the Fastify instance from all of the above
  config.ts      Environment-driven configuration (data dir, static dir, host/port)
test/            Vitest test suite (backend/test/*.test.ts, one file per module/route group)
scripts/         Build-time helper scripts (copy-migrations.mjs, copy-frontend.mjs)
```

## Testing

```bash
npm test
```

Real integration-style tests throughout — real SQLite databases in temp
directories, real `app.inject()` HTTP requests against the real Fastify
app, real local HTTP servers standing in for AI providers/Razorpay rather
than mocked `fetch`, and real subprocess execution for the test runner
(`src/testrunner/`). See [`../docs/TESTING.md`](../docs/TESTING.md) for
the full testing strategy and conventions.

**Windows note:** the test runner's real-process-execution tests
(`test/testrunner.test.ts`) spawn and kill real child processes and have
needed two rounds of Windows-specific fixes (see `src/testrunner/run.ts`'s
doc comments and `../docs/CHANGELOG.md`) — if you hit a hang or a stale
temp-directory cleanup error on Windows that isn't covered by those notes,
that's genuinely new information worth capturing there.

## Security model

Every route resolves filesystem access only through a project's
`root_path`, validated once at registration (`src/security/paths.ts`);
content sent to an AI provider is redacted for secrets first
(`src/security/secretPatterns.ts`); nothing AI-generated executes or
writes to disk without an explicit, server-side-enforced human-approval
gate. See [`../docs/SECURITY.md`](../docs/SECURITY.md) for the full model.
