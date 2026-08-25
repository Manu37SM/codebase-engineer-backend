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
// User-report fix: pasting a Google Drive "share" link
// (drive.google.com/file/d/<id>/view) here downloads Drive's HTML viewer
// page, not the zip's bytes — the resulting "archive" is actually a
// webpage, which AdmZip then fails to open with an opaque "No END header
// found" error that gives the user no idea what went wrong. Catch this
// specific, common mistake up front with an actionable message rather than
// letting it fail deep inside the zip parser.
const GOOGLE_DRIVE_LINK_PATTERN = /^https?:\/\/(drive|docs)\.google\.com\//i;

/**
 * A "Zip download URL" must be a direct, publicly-reachable link to the
 * file's raw bytes — the same kind of link a plain `curl`/browser download
 * would work with, no sign-in required. Share pages from Drive, Dropbox,
 * OneDrive, etc. serve an HTML viewer at that URL instead, which is why
 * this check exists as its own step.
 */
export async function downloadAndExtractZip(url: string, destDir: string): Promise<void> {
  const trimmedUrl = url.trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    throw new ZipDownloadError(`Not a valid http(s) URL: ${url}`);
  }
  if (GOOGLE_DRIVE_LINK_PATTERN.test(trimmedUrl)) {
    throw new ZipDownloadError(
      "This looks like a Google Drive link, not a direct download link — Drive share links open a viewer " +
        "page rather than serving the file's raw bytes, so this always fails. Use the \"Google Drive\" tab " +
        "instead to browse and import a zip file straight from your Drive."
    );
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
    if (response.status === 403) {
      throw new ZipDownloadError(
        `The server refused this download (403 Forbidden). This usually means the link requires sign-in or ` +
          `isn't shared publicly yet — make sure it's set to "Anyone with the link can view/download" and that ` +
          `it's a direct file link, not a page that requires clicking a download button.`
      );
    }
    if (response.status === 404) {
      throw new ZipDownloadError(`The server couldn't find this file (404 Not Found). Double-check the URL: ${url}`);
    }
    throw new ZipDownloadError(`Download failed with status ${response.status}: ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    throw new ZipDownloadError(
      `File too large (${contentLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes): ${url}`
    );
  }

  // Another common shape of the same underlying mistake: the URL "works"
  // (200 OK) but what's actually served is an HTML page — a login wall, a
  // "click here to download" landing page, etc. — rather than the zip
  // itself. Catching it here, before handing the bytes to AdmZip, lets the
  // error name the real problem instead of a cryptic zip-parsing failure.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) {
    throw new ZipDownloadError(
      `This URL returned a webpage instead of a zip file (content-type: ${contentType}). It's likely a share/` +
        `viewer page rather than a direct download link, or it requires signing in first — a direct zip link ` +
        `should be downloadable with no browser interaction at all.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new ZipDownloadError(
      `File too large (${buffer.byteLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes): ${url}`
    );
  }

  extractZipBuffer(buffer, destDir, { friendlyInvalidZipHint: true });
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
export function extractZipBuffer(
  buffer: Buffer,
  destDir: string,
  options?: { friendlyInvalidZipHint?: boolean }
): void {
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
      // options.friendlyInvalidZipHint is set only by downloadAndExtractZip
      // (the plain "Zip download URL" path), where an invalid archive most
      // often means the URL didn't actually point at a zip's raw bytes —
      // the Google Drive Reconnect page report that led here. The Drive
      // browse-and-import path (importDriveZipFile) downloads bytes
      // Google itself already confirmed as a zip file, so this specific
      // hint doesn't apply there.
      const hint = options?.friendlyInvalidZipHint
        ? " This usually means the URL isn't a direct link to a zip file's raw bytes — double-check it opens " +
          "a direct file download (not a webpage or a \"click to download\" landing page) when pasted into a " +
          "new browser tab with no sign-in."
        : "";
      throw new ZipDownloadError(`Not a valid zip archive: ${(err as Error).message}.${hint}`);
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
