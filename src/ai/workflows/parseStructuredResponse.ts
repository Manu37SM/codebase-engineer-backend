
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
