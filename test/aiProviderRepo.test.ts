import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, DB } from "../src/db/index.js";
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfigById,
  listProviderConfigs,
  maskApiKey,
  toPublic,
  updateProviderConfig,
} from "../src/db/aiProviderRepo.js";

describe("maskApiKey", () => {
  it("masks a short key entirely", () => {
    expect(maskApiKey("abc")).toBe("***");
  });

  it("shows first 4 and last 2 characters of a longer key", () => {
    expect(maskApiKey("sk-1234567890abcd")).toBe("sk-1...cd");
  });
});

describe("aiProviderRepo", () => {
  let tmpDir: string;
  let db: DB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ai-provider-test-"));
    db = openDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a provider config and never exposes the raw key via toPublic", () => {
    const record = createProviderConfig(db, "p1", {
      name: "My OpenAI",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-supersecretvalue",
    });
    expect(record.api_key).toBe("sk-supersecretvalue");

    const pub = toPublic(record);
    expect(pub).not.toHaveProperty("apiKey");
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyRef).toBe("sk-s...ue");
    expect(JSON.stringify(pub)).not.toContain("supersecret");
  });

  it("creates a provider with no API key (e.g. a local server) honestly", () => {
    const record = createProviderConfig(db, "p1", {
      name: "Local",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      apiKey: null,
    });
    expect(toPublic(record).hasApiKey).toBe(false);
    expect(toPublic(record).apiKeyRef).toBeNull();
  });

  it("lists providers newest first", () => {
    createProviderConfig(db, "p1", { name: "A", kind: "openai-compatible", baseUrl: null, model: null, apiKey: null });
    createProviderConfig(db, "p2", { name: "B", kind: "openai-compatible", baseUrl: null, model: null, apiKey: null });
    const configs = listProviderConfigs(db);
    expect(configs.map((c) => c.id)).toEqual(["p2", "p1"]);
  });

  it("updates fields and re-masks the key when it changes", () => {
    createProviderConfig(db, "p1", {
      name: "A",
      kind: "openai-compatible",
      baseUrl: "http://a",
      model: "m1",
      apiKey: "oldkeyvalue",
    });

    const updated = updateProviderConfig(db, "p1", { model: "m2", apiKey: "newkeyvalue123", enabled: true });
    expect(updated?.model).toBe("m2");
    expect(updated?.enabled).toBe(1);
    expect(toPublic(updated!).apiKeyRef).toBe("newk...23");
  });

  it("returns undefined when updating an unknown provider", () => {
    expect(updateProviderConfig(db, "does-not-exist", { enabled: true })).toBeUndefined();
  });

  it("deletes a provider and reports whether it existed", () => {
    createProviderConfig(db, "p1", { name: "A", kind: "openai-compatible", baseUrl: null, model: null, apiKey: null });
    expect(deleteProviderConfig(db, "p1")).toBe(true);
    expect(getProviderConfigById(db, "p1")).toBeUndefined();
    expect(deleteProviderConfig(db, "p1")).toBe(false);
  });
});
