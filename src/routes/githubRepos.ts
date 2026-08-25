import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getOauthIdentityForUser } from "../db/userRepo.js";
import { decryptToken } from "../auth/crypto.js";
import { createProject, getProjectByRootPath } from "../db/projectRepo.js";
import { assertValidProjectRoot } from "../security/paths.js";
import { buildGitHubCloneUrl, cloneWithToken, InvalidRepoFullNameError } from "../importer/githubClone.js";

interface RegisterGitHubRepoRoutesOptions {
  db: DB;
  /** Same data directory git/zip imports use (Task #85) — see BuildAppOptions.dataDir in app.ts. */
  dataDir: string;
}

const REPOS_URL = "https://api.github.com/user/repos";
const USER_AGENT = "codebase-engineer";
const MAX_PAGES = 5; // 5 * 100 = up to 500 repos, generous without being unbounded.
// Bug fix: the outbound call to GitHub's API had no timeout at all — on a
// stuck/slow connection (e.g. an egress network issue on the host) the
// fetch would hang indefinitely, leaving the frontend's "Loading your
// repositories…" spinning forever with no error ever surfacing. Bounding
// it means a genuinely stuck request now fails loudly (502) within a
// fixed window instead of hanging the request forever.
const FETCH_TIMEOUT_MS = 15_000;

interface GitHubApiRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  updated_at: string;
  fork: boolean;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string;
  updatedAt: string;
  fork: boolean;
}

function nextLinkFromHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Standard GitHub pagination header: `<url>; rel="next", <url>; rel="last"`.
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * GitHub repo browser + clone-to-register (Task #84) — uses the encrypted
 * access token stored when the user signed in with GitHub (Task #83) to
 * list their repos, then clones a chosen one onto this same machine and
 * registers it exactly like any other imported project (Task #85's
 * `/projects/import`, reused indirectly via `createProject`). Still
 * local-first: the only thing that ever leaves this machine is the
 * outbound call to GitHub's own API/git-over-https using the user's own
 * token — no third-party server, no per-user server-side storage.
 *
 * Both routes require a signed-in user (they run behind `authGuard`,
 * since neither path is in its public-path allowlist) — GitHub OAuth
 * sign-in always creates a real account, so by the time a token exists to
 * browse with, auth is already required for this instance anyway.
 */
export function registerGitHubRepoRoutes(app: FastifyInstance, { db, dataDir }: RegisterGitHubRepoRoutesOptions): void {
  function requireGitHubToken(userId: string): { token: string } | { error: { status: number; message: string } } {
    const identity = getOauthIdentityForUser(db, userId, "github");
    if (!identity || !identity.access_token_enc) {
      return {
        error: {
          status: 400,
          message: "GitHub is not connected. Sign in with GitHub (or link it) first, then try again.",
        },
      };
    }
    try {
      return { token: decryptToken(identity.access_token_enc) };
    } catch {
      return { error: { status: 500, message: "Stored GitHub token could not be decrypted." } };
    }
  }

  app.get("/api/v1/github/repos", async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: "Authentication required." });
    }
    const resolved = requireGitHubToken(request.user.id);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }

    const repos: GitHubRepoSummary[] = [];
    let url: string | null = `${REPOS_URL}?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
    let pages = 0;

    try {
      while (url && pages < MAX_PAGES) {
        const res: Response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${resolved.token}`,
            "User-Agent": USER_AGENT,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return reply.status(502).send({ error: `GitHub rejected the repository list request (status ${res.status}).` });
        }
        const page = (await res.json()) as GitHubApiRepo[];
        for (const r of page) {
          repos.push({
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            private: r.private,
            htmlUrl: r.html_url,
            description: r.description,
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at,
            fork: r.fork,
          });
        }
        url = nextLinkFromHeader(res.headers.get("link"));
        pages++;
      }
    } catch {
      return reply.status(502).send({ error: "Could not reach GitHub to list repositories." });
    }

    return reply.status(200).send({ repos, truncated: url !== null });
  });

  app.post("/api/v1/github/import", async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: "Authentication required." });
    }
    const resolved = requireGitHubToken(request.user.id);
    if ("error" in resolved) {
      return reply.status(resolved.error.status).send({ error: resolved.error.message });
    }

    const body = request.body as { fullName?: string; name?: string } | undefined;
    if (!body?.fullName) {
      return reply.status(400).send({ error: "fullName ('owner/repo') is required." });
    }

    let cloneUrl: string;
    try {
      cloneUrl = buildGitHubCloneUrl(body.fullName);
    } catch (err) {
      if (err instanceof InvalidRepoFullNameError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const importId = randomUUID();
    const destDir = path.join(dataDir, "imports", importId);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });

    try {
      cloneWithToken(cloneUrl, destDir, resolved.token);
    } catch (err) {
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

    const name = body.name?.trim() || body.fullName.split("/")[1] || body.fullName;
    const project = createProject(db, randomUUID(), name, destDir);
    return reply.status(201).send({ project });
  });
}
