import { describe, it, expect } from "vitest";
import { parseStructuredSections, parseBulletList } from "../src/ai/workflows/parseStructuredResponse.js";

describe("parseStructuredSections", () => {
  const HEADERS = ["ONE", "TWO", "THREE"];

  it("parses all sections when the response follows the format exactly", () => {
    const raw = "ONE:\nfirst\n\nTWO:\nsecond\n\nTHREE:\nthird";
    expect(parseStructuredSections(raw, HEADERS)).toEqual({ ONE: "first", TWO: "second", THREE: "third" });
  });

  it("stops a section at ANY later header, not just the immediately-next one, when a middle header is missing", () => {

    const raw = "ONE:\nfirst\n\nTHREE:\nthird";
    const result = parseStructuredSections(raw, HEADERS);
    expect(result.ONE).toBe("first");
    expect(result.TWO).toBeNull();
    expect(result.THREE).toBe("third");
  });

  it("returns null for every header when none are present, never fabricating structure", () => {
    const raw = "Just a plain paragraph with no headers at all.";
    expect(parseStructuredSections(raw, HEADERS)).toEqual({ ONE: null, TWO: null, THREE: null });
  });

  it("is case-insensitive on header matching", () => {
    const raw = "one:\nlower\n\ntwo:\nalso lower";
    const result = parseStructuredSections(raw, HEADERS);
    expect(result.ONE).toBe("lower");
    expect(result.TWO).toBe("also lower");
  });

  it("captures the last header through to the end of the string", () => {
    const raw = "ONE:\na\n\nTHREE:\nb\nc\nd";
    const result = parseStructuredSections(raw, HEADERS);
    expect(result.THREE).toBe("b\nc\nd");
  });

  it("handles headers containing regex-special characters safely", () => {
    const result = parseStructuredSections("FILES (AFFECTED):\na.ts\nb.ts", ["FILES (AFFECTED)"]);
    expect(result["FILES (AFFECTED)"]).toBe("a.ts\nb.ts");
  });
});

describe("parseBulletList", () => {
  it("splits bullet lines, stripping leading markers and blank lines", () => {
    expect(parseBulletList("- one\n* two\n  - three\n\n")).toEqual(["one", "two", "three"]);
  });

  it("returns null for an empty or null section rather than an empty array", () => {
    expect(parseBulletList(null)).toBeNull();
    expect(parseBulletList("")).toBeNull();
    expect(parseBulletList("   \n  \n")).toBeNull();
  });

  it("handles a single unbulleted line as one item", () => {
    expect(parseBulletList("just one line, no bullet marker")).toEqual(["just one line, no bullet marker"]);
  });
});
