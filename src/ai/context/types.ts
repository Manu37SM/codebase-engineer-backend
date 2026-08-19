export interface ContextItem {
  path: string;
  reason: string;
  tokens: number;
  /**
   * The actual (already-redacted) text selected for this item — optional so
   * the Phase 13 preview API/UI, and existing tests, can keep treating a
   * `ContextBundle` as the lightweight `path`/`reason`/`tokens` summary
   * docs/AI_MODE.md §3 defines. Phase 14's `explainFinding` workflow is the
   * first real consumer that needs `content`, to actually build a prompt
   * rather than just describe what would be in one.
   */
  content?: string;
}

export interface ExcludedItem {
  path: string;
  reason: string;
}

/** Per docs/AI_MODE.md §3 — the bounded, explained context sent (eventually) to an AI provider. */
export interface ContextBundle {
  targetId: string;
  budgetTokens: number;
  selected: ContextItem[];
  excluded: ExcludedItem[];
  totalTokens: number;
}

/**
 * A `Finding` target and a failed-`TestRun` target are implemented (Phase
 * 13 and Phase 20, respectively — see `selectContextForTestFailure.ts`).
 * The free-form refactor-request target named in docs/AI_MODE.md §3
 * remains deferred, honestly, rather than given a half-built selection
 * strategy with nothing real to test it against (no consuming AI-Mode
 * feature exists for it yet).
 */
export interface FindingTarget {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
}

/**
 * A failed `TestRun` target (Phase 20). Unlike a `Finding`, there's no
 * single file/line the failure is "at" — the relevant context has to be
 * inferred from the captured output itself (which files it mentions,
 * which stack frames it prints), so `selectContextForTestFailure` takes
 * the run's own stdout/stderr rather than a file/line pointer.
 */
export interface TestFailureTarget {
  id: string;
  command: string | null;
  framework: string | null;
  stdout: string;
  stderr: string;
}

export interface FileForSelection {
  relativePath: string;
  language: string | null;
  imports: string[];
  isTest: boolean;
}
