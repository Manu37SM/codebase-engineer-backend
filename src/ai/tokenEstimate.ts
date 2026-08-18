/**
 * A documented characters/4 approximation — not a real per-model
 * tokenizer (that needs a model-specific vocabulary and an extra
 * dependency). Good enough for this product's two actual uses: an
 * adapter's `estimateTokens()` (context-budget bookkeeping, not
 * billing-accurate counts) and the AI context selector (Phase 13), which
 * needs a consistent, provider-agnostic way to size candidate context
 * items against a token budget before any provider is even configured.
 * Shared here so both call sites can't drift apart on the formula.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
