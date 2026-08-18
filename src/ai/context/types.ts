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
 * Only a `Finding` target is implemented so far — the failed-`TestRun` and
 * free-form refactor-request targets named in docs/AI_MODE.md §3 are
 * deferred, honestly, rather than given a half-built selection strategy
 * with nothing real to test it against (neither has a consuming AI-Mode
 * feature yet either — those are Phase 19+/16+).
 */
export interface FindingTarget {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface FileForSelection {
  relativePath: string;
  language: string | null;
  imports: string[];
  isTest: boolean;
}
