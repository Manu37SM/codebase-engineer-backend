import { getGoogleOAuthConfig } from "../auth/oauthConfig.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

const FETCH_TIMEOUT_MS = 15_000;

export class GoogleDriveError extends Error {}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const config = getGoogleOAuthConfig();
  if (!config) {
    throw new GoogleDriveError("Google sign-in is not configured on this server.");
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleDriveError(`Could not reach Google to refresh the access token: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new GoogleDriveError(`Google rejected the token refresh request (status ${response.status}).`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new GoogleDriveError("Google did not return a refreshed access token.");
  }
  return body.access_token;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: string | null;
}

interface DriveFilesListResponse {
  files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; size?: string }>;
  nextPageToken?: string;
}

const MAX_PAGES = 5; 

export async function listDriveZipFiles(accessToken: string): Promise<{ files: DriveFileSummary[]; truncated: boolean }> {
  const files: DriveFileSummary[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const url = new URL(DRIVE_FILES_URL);

    url.searchParams.set(
      "q",
      "(fileExtension='zip' or mimeType='application/zip' or mimeType='application/x-zip-compressed' " +
        "or mimeType='application/x-zip') and trashed=false"
    );
    url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, modifiedTime, size)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("spaces", "drive");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoogleDriveError(`Could not reach Google Drive: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      throw new GoogleDriveTokenExpiredError();
    }
    if (!res.ok) {
      throw new GoogleDriveError(`Google Drive rejected the file list request (status ${res.status}).`);
    }

    const body = (await res.json()) as DriveFilesListResponse;
    for (const f of body.files ?? []) {
      files.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        size: f.size ?? null,
      });
    }
    pageToken = body.nextPageToken;
    pages++;
    if (pageToken && pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  } while (pageToken);

  return { files, truncated };
}

export class GoogleDriveTokenExpiredError extends GoogleDriveError {
  constructor() {
    super("Google access token expired or was rejected.");
    this.name = "GoogleDriveTokenExpiredError";
  }
}

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; 

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export async function downloadDriveFile(accessToken: string, fileId: string): Promise<Buffer> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleDriveError(`Could not reach Google Drive: ${(err as Error).message}`);
  }
  if (res.status === 401) {
    throw new GoogleDriveTokenExpiredError();
  }
  if (!res.ok) {
    throw new GoogleDriveError(`Google Drive rejected the download request (status ${res.status}).`);
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    throw new GoogleDriveError(`File too large (${contentLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new GoogleDriveError(`File too large (${buffer.byteLength} bytes; limit is ${MAX_DOWNLOAD_BYTES} bytes).`);
  }
  return buffer;
}
