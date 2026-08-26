import { describe, it, expect, afterEach, vi } from "vitest";
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
      if (req.url === "/forbidden") {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (req.url === "/viewer-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<html>sign in to view</html>");
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

function buildWrappedZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("my-repo-main/README.md", Buffer.from("# hello\n"));
  zip.addFile("my-repo-main/src/main.ts", Buffer.from("console.log('hi');\n"));
  return zip.toBuffer();
}

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

  it("gives a friendly, actionable error for a Google Drive share link instead of a raw zip-parse failure", async () => {
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
    await expect(
      downloadAndExtractZip("https://drive.google.com/file/d/abc123/view?usp=sharing", destDir)
    ).rejects.toThrow(/Google Drive/i);
  });

  it("gives a friendly 403 message instead of a bare status code", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
    await expect(downloadAndExtractZip(`${server.url}/forbidden`, destDir)).rejects.toThrow(
      /shared publicly|Forbidden/i
    );
  });

  it("gives a friendly message when the URL serves an HTML page instead of a zip", async () => {
    server = await startZipServer(buildFlatZip());
    destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
    await expect(downloadAndExtractZip(`${server.url}/viewer-page`, destDir)).rejects.toThrow(/webpage/i);
  });

  describe("OneDrive links", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("sends a realistic browser User-Agent on every request", async () => {
      destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
      const zipBuffer = buildFlatZip();
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        url: "https://example.com/archive.zip",
        headers: new Headers({ "content-type": "application/zip", "content-length": String(zipBuffer.length) }),
        arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
      }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await downloadAndExtractZip("https://example.com/archive.zip", destDir);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const options = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
      expect(options.headers["User-Agent"]).toMatch(/Mozilla/);
    });

    it("automatically retries a blocked 1drv.ms link with the download=1 shape and succeeds", async () => {
      destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
      const zipBuffer = buildFlatZip();
      const resolvedUrl = "https://onedrive.live.com/redir?resid=ABC123&authkey=xyz";
      let call = 0;
      global.fetch = vi.fn(async (input: unknown) => {
        call++;
        const requestUrl = typeof input === "string" ? input : (input as URL).toString();
        if (call === 1) {

          return {
            ok: false,
            status: 403,
            url: resolvedUrl,
            headers: new Headers(),
          };
        }

        expect(requestUrl).toBe(`${resolvedUrl}&download=1`);
        return {
          ok: true,
          status: 200,
          url: requestUrl,
          headers: new Headers({ "content-type": "application/zip", "content-length": String(zipBuffer.length) }),
          arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength),
        };
      }) as unknown as typeof fetch;

      await downloadAndExtractZip("https://1drv.ms/u/s!ABC123", destDir);

      expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    });

    it("gives a OneDrive-specific hint when the automatic retry also fails", async () => {
      destDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-zip-test-")), "extracted");
      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 403,
        url: "https://onedrive.live.com/redir?resid=ABC123",
        headers: new Headers(),
      })) as unknown as typeof fetch;

      await expect(downloadAndExtractZip("https://1drv.ms/u/s!ABC123", destDir)).rejects.toThrow(/OneDrive/i);
    });
  });
});

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
