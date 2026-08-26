import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; 

export class ZipDownloadError extends Error {}

const GOOGLE_DRIVE_LINK_PATTERN = /^https?:\/\/(drive|docs)\.google\.com\//i;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isOneDriveHost(...urls: Array<string | undefined>): boolean {
  return urls.some((u) => {
    if (!u) return false;
    let hostname: string;
    try {
      hostname = new URL(u).hostname.toLowerCase();
    } catch {
      return false;
    }
    return (
      hostname === "1drv.ms" ||
      hostname.endsWith(".1drv.ms") ||
      hostname === "onedrive.live.com" ||
      hostname.endsWith(".onedrive.live.com") ||
      hostname.endsWith(".sharepoint.com")
    );
  });
}

async function tryOneDriveDirectDownload(resolvedUrl: string): Promise<Response | null> {
  let target: URL;
  try {
    target = new URL(resolvedUrl);
  } catch {
    return null;
  }
  if (target.searchParams.get("download") === "1") return null; 
  target.searchParams.set("download", "1");
  try {
    const retryResponse = await fetch(target.toString(), {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "*/*" },
    });
    if (retryResponse.ok && !(retryResponse.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
      return retryResponse;
    }
    return null;
  } catch {
    return null;
  }
}

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
    response = await fetch(url, { headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "*/*" } });
  } catch (err) {
    throw new ZipDownloadError(`Could not reach ${url}: ${(err as Error).message}`);
  }

  const initiallyBlocked =
    !response.ok || (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (initiallyBlocked && isOneDriveHost(trimmedUrl, response.url)) {
    const retried = await tryOneDriveDirectDownload(response.url || trimmedUrl);
    if (retried) response = retried;
  }

  const isOneDrive = isOneDriveHost(trimmedUrl, response.url);

  if (!response.ok) {
    if (response.status === 403) {
      const oneDriveHint = isOneDrive
        ? " For OneDrive links specifically: double-check the permission is set to \"Anyone with the link can " +
          "view\" (editing access isn't required and can trigger extra checks), and copy a fresh link right " +
          "before pasting it here — OneDrive links can expire."
        : "";
      throw new ZipDownloadError(
        `The server refused this download (403 Forbidden). This usually means the link requires sign-in or ` +
          `isn't shared publicly yet — make sure it's set to "Anyone with the link can view/download" and that ` +
          `it's a direct file link, not a page that requires clicking a download button.${oneDriveHint}`
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

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) {
    const oneDriveHint = isOneDrive
      ? " Tried OneDrive's direct-download link shape automatically and it still returned a page — the file's " +
        "sharing permission may not actually be public yet."
      : "";
    throw new ZipDownloadError(
      `This URL returned a webpage instead of a zip file (content-type: ${contentType}). It's likely a share/` +
        `viewer page rather than a direct download link, or it requires signing in first — a direct zip link ` +
        `should be downloadable with no browser interaction at all.${oneDriveHint}`
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

    }
  }
}

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
