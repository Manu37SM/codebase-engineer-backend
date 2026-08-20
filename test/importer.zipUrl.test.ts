import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import AdmZip from "adm-zip";
import { downloadAndExtractZip, extractZipBuffer, ZipDownloadError } from "../src/importer/zipUrl.js";

function startZipServer(zipBuffer: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/404") {
        res.writeHead(404).end("not found");
        return;
      }
      if (req.url === "/not-a-zip") {
        res.writeHead(200, { "content-type": "text/plain" }).end("this is not a zip file");
        return;
      }
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(zipBuffer.length) });
      res.end(zipBuffer);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Builds a real zip archive in memory with a single top-level wrapper folder — the common GitHub "Download ZIP" shape. */
function buildWrappedZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("my-repo-main/README.md", Buffer.from("# hello\n"));
  zip.addFile("my-repo-main/src/main.ts", Buffer.from("console.log('hi');\n"));
  return zip.toBuffer();
}

/** A zip with multiple top-level entries — should NOT be flattened. */
function buildFlatZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("README.md", Buffer.from("# hello\n"));
  zip.addFile("src/main.ts", Buffer.from("console.log('hi');\n"));
  return zip.toBuffer();
}

describe("downloadAndExtractZip", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  let destDir: string | null = null;

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    if (destDir && fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    destDir = null;
  });

  it("downloads and extracts a real zip, flattening a single top-level wrapper directory", async () => {
    server = await startZipServer(buildWrappedZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");

    await downloadAndExtractZip(server.url, destDir);

    // Flattened: README.md is directly in destDir, not under my-repo-main/.
    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src/main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "my-repo-main"))).toBe(false);
  });

  it("does not flatten a zip with multiple top-level entries", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");

    await downloadAndExtractZip(server.url, destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src/main.ts"))).toBe(true);
  });

  it("rejects a non-2xx response", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");

    await expect(downloadAndExtractZip(`${server.url}/404`, destDir)).rejects.toThrow(ZipDownloadError);
  });

  it("rejects content that isn't actually a zip archive", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");

    await expect(downloadAndExtractZip(`${server.url}/not-a-zip`, destDir)).rejects.toThrow(ZipDownloadError);
  });

  it("rejects a non-http(s) URL", async () => {
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
    await expect(downloadAndExtractZip("ftp://example.com/archive.zip", destDir)).rejects.toThrow(ZipDownloadError);
  });

  it("refuses to extract into a directory that already exists", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-existing-"));
    await expect(downloadAndExtractZip(server.url, destDir)).rejects.toThrow(/already exists/);
  });
});

// Task #86: `extractZipBuffer` is the extraction/flattening core that
// `downloadAndExtractZip` now delegates to, split out so the Google Drive
// importer (which downloads bytes via an authenticated fetch, not a plain
// unauthenticated `fetch(url)`) can reuse identical behavior. Covered
// directly here — in-memory, no HTTP server needed — in addition to the
// `downloadAndExtractZip` tests above that exercise it indirectly.
describe("extractZipBuffer", () => {
  let tmpRoot: string | null = null;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("extracts and flattens a single top-level wrapper directory", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ce-extractbuf-test-"));
    const destDir = path.join(tmpRoot, "extracted");
    extractZipBuffer(buildWrappedZip(), destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src/main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "my-repo-main"))).toBe(false);
  });

  it("leaves a multi-top-level-entry zip unflattened", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ce-extractbuf-test-"));
    const destDir = path.join(tmpRoot, "extracted");
    extractZipBuffer(buildFlatZip(), destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src/main.ts"))).toBe(true);
  });

  it("rejects a buffer that isn't actually a zip archive", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ce-extractbuf-test-"));
    const destDir = path.join(tmpRoot, "extracted");
    expect(() => extractZipBuffer(Buffer.from("not a zip"), destDir)).toThrow(ZipDownloadError);
  });

  it("refuses to extract into a directory that already exists", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ce-extractbuf-test-existing-"));
    expect(() => extractZipBuffer(buildFlatZip(), tmpRoot)).toThrow(/already exists/);
  });
});
