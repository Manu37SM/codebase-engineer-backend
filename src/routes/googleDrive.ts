import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getOauthIdentityForUser, updateOauthTokens } from "../db/userRepo.js";
import { decryptToken, encryptToken } from "../auth/crypto.js";
import { createProject, getProjectByRootPath } from "../db/projectRepo.js";
import { assertValidProjectRoot } from "../security/paths.js";
import { extractZipBuffer, ZipDownloadError } from "../importer/zipUrl.js";
import {
  GoogleDriveError,
  GoogleDriveTokenExpiredError,
  downloadDriveFile,
  listDriveZipFiles,
  refreshGoogleAccessToken,
} from "../importer/googleDrive.js";

interface RegisterGoogleDriveRoutesOptions {
  db: DB;
  /** Same data directory git/zip/GitHub imports use (Tasks #85/#84) — see BuildAppOptions.dataDir in app.ts. */
  dataDir: string;
}

/**
 * Google Drive zip-file picker (Task #86) — lets a user who signed in
 * with Google (Task #82, now also granted `drive.readonly`, see
 * `oauthGoogle.ts`) list zip files in their own Drive and import one onto
 * this machine, exactly like the GitHub repo browser (Task #84) does for
 * repos and `zipUrl.ts` (Task #85) does for a plain download URL. Still
 * local-first: the only network calls are outbound to Google's own API
 * using the signed-in user's own token, and the archive is extracted
 * straight onto this machine — nothing is proxied or stored server-side
 * beyond the encrypted OAuth token itself.
 *
 * Both routes require a signed-in user (run behind `authGuard`, since
 * neither path is in its public-path allowlist) — Google OAuth sign-in
 * always creates a real account, so by the time a token exists to browse
 * with, auth is already required for this instance anyway.
 */
export function registerGoogleDriveRoutes(app: FastifyInstance, { db, dataDir }: RegisterGoogleDriveRoutesOptions): void {
  /**
   * Resolves a usable Drive access token for `userId`, refreshing it via
   * the stored refresh token first if the identity has one — Drive
   * browsing may happen long after the ~1 hour access-token lifetime, so
   * this always refreshes proactively rather than waiting for a 401
   * (simpler than tracking a separate expiry timestamp, and Google's
   * token endpoint is cheap/fast to call).
   */
  async function resolveDriveAccessToken(
    userId: string
  ): Promise<{ token: string } | { error: { status: number; message: string } }> {
    const identity = getOauthIdentityForUser(db, userId, "google");
    if (!identity || !identity.access_token_enc) {
      return {
        error: {
          status: 400,
          message: "Google is not connected. Sign in with Google first, then try again.",
        },
      };
    }

    if (identity.refresh_token_enc) {
      try {
        const refreshToken = decryptToken(identity.refresh_token_enc);
        const freshAccessToken = await refreshGoogleAccessToken(refreshToken);
        updateOauthTokens(db, identity.id, encryptToken(freshAccessToken), null);
        return { token: freshAccessToken };
      } catch (err) {
        if (err instanceof GoogleDriveError) {
          // Fall through and try the previously-stored access token — it
          // may still be valid (e.g. refresh failed transiently).
        } else {
          return { error: { status: 500, message: `Could not refresh the Google token: ${(err as Error).message}` } };
        }
      }
    }

    try {
      return { token: decryptToken(identity.access_token_enc) };
    } catch {
      return { error: { status: 500, message: "Stored Google token could not be decrypted." } };
    }
  }

  app.get("/api/v1/google-drive/zips", async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: "Authentication required." });
    }
    const resolved = await resolveDriveAccessToken(request.user.id);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }

    try {
      const { files, truncated } = await listDriveZipFiles(resolved.token);
      return reply.status(200).send({ files, truncated });
    } catch (err) {
      if (err instanceof GoogleDriveTokenExpiredError) {
        return reply.status(400).send({
          error: "Google access was rejected. Try disconnecting and reconnecting your Google account.",
        });
      }
      if (err instanceof GoogleDriveError) {
        return reply.status(502).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/api/v1/google-drive/import", async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: "Authentication required." });
    }
    const resolved = await resolveDriveAccessToken(request.user.id);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }

    const body = request.body as { fileId?: string; name?: string } | undefined;
    if (!body?.fileId) {
      return reply.status(400).send({ error: "fileId is required." });
    }

    let buffer: Buffer;
    try {
      buffer = await downloadDriveFile(resolved.token, body.fileId);
    } catch (err) {
      if (err instanceof GoogleDriveTokenExpiredError) {
        return reply.status(400).send({
          error: "Google access was rejected. Try disconnecting and reconnecting your Google account.",
        });
      }
      if (err instanceof GoogleDriveError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const importId = randomUUID();
    const destDir = path.join(dataDir, "imports", importId);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });

    try {
      extractZipBuffer(buffer, destDir);
    } catch (err) {
      if (err instanceof ZipDownloadError) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(400).send({ error: (err as Error).message });
    }

    try {
      assertValidProjectRoot(destDir);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const existing = getProjectByRootPath(db, destDir);
    if (existing) {
      return reply.status(409).send({ error: "A project is already registered for this path", project: existing });
    }

    const name = body.name?.trim() || body.fileId;
    const project = createProject(db, randomUUID(), name, destDir);
    return reply.status(201).send({ project });
  });
}
