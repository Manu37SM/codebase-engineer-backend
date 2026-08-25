import { getGoogleOAuthConfig } from "../auth/oauthConfig.js";

/**
 * Google Drive access-token refresh + list/download helpers (Task #86).
 *
 * A Google OAuth *access* token expires in about an hour, but Drive
 * browsing can happen well after sign-in (a user might sign in Monday and
 * come back Friday to import a zip). Rather than forcing a fresh sign-in
 * every time, this reuses the `refresh_token` that's already requested
 * (`access_type=offline`, `prompt=consent` in `oauthGoogle.ts`) and stored
 * encrypted on first consent (`updateOauthTokens`/`createOauthIdentity`)
 * to mint a new access token on demand.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
// Bug fix: none of the three outbound fetches below (token refresh, list
// files, download file) had a timeout — a stuck/slow connection would
// hang the request forever with no error ever reaching the frontend
// (reported as "Loading your Drive files…" never finishing). Bounded so a
// genuinely stuck call fails loudly within a fixed window instead.
const FETCH_TIMEOUT_MS = 15_000;

export class GoogleDriveError extends Error {}

/** Exchanges a stored refresh token for a fresh access token. */
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

const MAX_PAGES = 5; // matches githubRepos.ts's own pagination cap.

/** Lists zip files in the user's Drive (not trashed), across up to MAX_PAGES pages. */
export async function listDriveZipFiles(accessToken: string): Promise<{ files: DriveFileSummary[]; truncated: boolean }> {
  const files: DriveFileSummary[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const url = new URL(DRIVE_FILES_URL);
    // Bug fix (user report): a zip made via Windows' "Compress to ZIP"
    // (or several other zip tools) often gets stored in Drive tagged with
    // a mimeType other than the canonical 'application/zip' — e.g.
    // 'application/x-zip-compressed' — so filtering on that one exact
    // mimeType silently hid otherwise-perfectly-valid zip files from this
    // list. `fileExtension='zip'` matches by the file's actual extension
    // regardless of what mimeType Drive guessed, which is what users
    // actually mean by "my zip files"; the mimeType clause is kept as a
    // fallback for the rare zip uploaded without a .zip extension.
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

/** Thrown when the access token is rejected (expired) so the caller can refresh + retry once. */
export class GoogleDriveTokenExpiredError extends GoogleDriveError {
  constructor() {
    super("Google access token expired or was rejected.");
    this.name = "GoogleDriveTokenExpiredError";
  }
}

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // matches zipUrl.ts's own limit.

// Downloading the actual file bytes can legitimately take a while for a
// large zip — matches githubClone.ts's own 5-minute clone timeout rather
// than the short window used for the quick metadata calls above.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Downloads a Drive file's raw bytes via an authenticated fetch. */
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
