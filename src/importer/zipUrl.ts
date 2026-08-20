import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";

/**
 * Registration by plain zip/download URL (Task #85) — downloads a zip
 * archive and extracts it locally, exactly like unzipping a downloaded
 * file yourself. Still local-first: the archive is fetched and extracted
 * onto this same machine, under its own data directory.
 */

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB — generous for a source archive, not unbounded.

export class ZipDownloadError extends Error {}

/**
 * Downloads `url`, extracts it into `destDir` (which must not already
 * exist), and — if the archive's contents are a single top-level
 * directory (the common case for a GitHub/GitLab "Download ZIP", which
 * wraps everything in `<repo>-<branch>/`) — flattens that one level so
 * `destDir` itself is the actual project root rather than a wrapper
 * directory containing it.
 */
export async function downloadAndExtractZip(url: string, destDir: string): Promise<void> {
  if (!/^https?:\/\//i.test(url.trim())) {
    throw new ZipDownloadError(`Not a valid http(s) URL: ${url}`);
  }
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new ZipDownloadError(`Could not reach ${url}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new ZipDownloadError(`Download failed with status ${response.status}: ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    throw new ZipDownloadError(
      `File too large (${contentLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes): ${url}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new ZipDownloadError(
      `File too large (${buffer.byteLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes): ${url}`
    );
  }

  extractZipBuffer(buffer, destDir);
}

/**
 * Extracts an in-memory zip buffer into `destDir` (which must not already
 * exist), flattening a single top-level wrapper directory the same way
 * `downloadAndExtractZip` does. Split out so callers that already have the
 * archive's bytes some other way (Task #86's Google Drive import
 * downloads via an authenticated `fetch` with a Bearer token, which
 * `downloadAndExtractZip`'s own plain unauthenticated `fetch(url)` can't
 * do) can reuse the exact same extraction/flattening behavior rather than
 * duplicating it.
 */
export function extractZipBuffer(buffer: Buffer, destDir: string): void {
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }

  const tmpZipPath = path.join(os.tmpdir(), `ce-import-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(tmpZipPath, buffer);

  try {
    let zip: AdmZip;
    try {
      zip = new AdmZip(tmpZipPath);
    } catch (err) {
      throw new ZipDownloadError(`Not a valid zip archive: ${(err as Error).message}`);
    }

    fs.mkdirSync(destDir, { recursive: true });
    zip.extractAllTo(destDir, true);

    flattenSingleTopLevelDirectory(destDir);
  } finally {
    try {
      fs.unlinkSync(tmpZipPath);
    } catch {
      // best-effort cleanup only
    }
  }
}

/**
 * If `dir` contains exactly one entry and it's a directory, moves that
 * directory's contents up into `dir` and removes the now-empty wrapper —
 * handles the common "single top-level folder" shape of a GitHub/GitLab
 * source zip so the registered project root is the actual code, not a
 * layer of indirection above it.
 */
function flattenSingleTopLevelDirectory(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;

  const wrapperName = entries[0].name;
  const wrapperPath = path.join(dir, wrapperName);
  const innerEntries = fs.readdirSync(wrapperPath);

  for (const name of innerEntries) {
    fs.renameSync(path.join(wrapperPath, name), path.join(dir, name));
  }
  fs.rmdirSync(wrapperPath);
}
