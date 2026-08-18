/**
 * Shared parser behind every AI workflow that asks a provider to respond
 * in a fixed "HEADER:\n...content..." shape — Phase 15's root-cause
 * analysis (3 headers: EVIDENCE/INFERENCE/CONFIDENCE) and Phase 16's fix
 * plan (7 headers, per docs/AI_MODE.md §5) both need the same thing:
 * split a response into named sections, tolerating providers that don't
 * perfectly follow instructions.
 *
 * Each section's terminator is "any later header in the list, or end of
 * string" — not just the immediately-next header. That generalization
 * fixes a real bug Phase 15 shipped with and later caught by test: if the
 * model skips a middle header (e.g. no INFERENCE: section), a
 * next-header-only terminator lets that missing header's neighbor bleed
 * into the previous section. Stopping at *any* later header avoids that
 * regardless of which one the model happens to omit.
 */
export function parseStructuredSections(raw: string, headers: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const laterHeaders = headers.slice(i + 1).map(escapeRegex);
    const lookahead = laterHeaders.length > 0 ? `\\n\\s*(?:${laterHeaders.join("|")}):|$` : "$";
    const pattern = new RegExp(`${escapeRegex(header)}:\\s*([\\s\\S]*?)(?=${lookahead})`, "i");
    const match = raw.match(pattern);
    result[header] = match ? match[1].trim() || null : null;
  }
  return result;
}

/** Splits a section's text into bullet-list lines (stripping leading "-"/"*"/whitespace), dropping blanks. Returns `null` (never an empty array) when there's nothing usable. */
export function parseBulletList(section: string | null): string[] | null {
  if (!section) return null;
  const lines = section
    .split("\n")
    .map((line) => line.replace(/^[\s*-]+/, "").trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
