import { describe, it, expect } from "vitest";
import { createProvider } from "../src/ai/provider/registry.js";

describe("createProvider", () => {
  it("builds a real openai-compatible provider from a config", () => {
    const provider = createProvider({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      model: "gpt-test",
      apiKey: "key",
    });
    expect(provider.id).toBe("openai-compatible");
    expect(provider.displayName).toBe("OpenAI-compatible");
  });

  it("throws an honest 'not yet supported' error for an unimplemented kind", () => {
    expect(() =>
      createProvider({ kind: "anthropic-compatible", baseUrl: "http://x", model: "m", apiKey: null })
    ).toThrow(/not yet supported/);
  });

  it("throws when base URL is missing", () => {
    expect(() =>
      createProvider({ kind: "openai-compatible", baseUrl: null, model: "m", apiKey: null })
    ).toThrow(/base URL/);
  });

  it("throws when model is missing", () => {
    expect(() =>
      createProvider({ kind: "openai-compatible", baseUrl: "http://x", model: null, apiKey: null })
    ).toThrow(/model/);
  });
});
