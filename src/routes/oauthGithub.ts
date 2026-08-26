import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getGitHubOAuthConfig } from "../auth/oauthConfig.js";
import { beginOAuthState, verifyAndClearOAuthState } from "../auth/oauthState.js";
import { resolveCurrentUserId } from "../auth/guard.js";
import { setSessionCookie } from "../auth/session.js";
import { encryptToken } from "../auth/crypto.js";
import {
  createOauthIdentity,
  createSession,
  createUser,
  getOauthIdentity,
  getUserByEmail,
  updateOauthTokens,
} from "../db/userRepo.js";

interface RegisterGitHubOAuthRoutesOptions {
  db: DB;
}

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

const SCOPES = "read:user user:email repo";
const USER_AGENT = "codebase-engineer";

interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GitHubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function registerGitHubOAuthRoutes(app: FastifyInstance, { db }: RegisterGitHubOAuthRoutesOptions): void {
  app.get("/api/v1/auth/github/start", async (request, reply) => {
    const config = getGitHubOAuthConfig();
    if (!config) {
      return reply
        .status(404)
        .send({ error: "GitHub sign-in is not configured on this server. See backend/.env.example / docs/AUTH.md." });
    }

    const state = beginOAuthState(request, reply, "github");
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);

    return reply.redirect(url.toString());
  });

  app.get("/api/v1/auth/github/callback", async (request, reply) => {
    const config = getGitHubOAuthConfig();
    if (!config) {
      return reply.status(404).send({ error: "GitHub sign-in is not configured on this server." });
    }

    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.status(400).send({ error: `GitHub sign-in was cancelled or failed: ${query.error}` });
    }
    if (!verifyAndClearOAuthState(request, reply, "github", query.state)) {
      return reply.status(400).send({ error: "Invalid or expired sign-in request — please try again." });
    }
    if (!query.code) {
      return reply.status(400).send({ error: "GitHub did not return an authorization code." });
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          code: query.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
        }),
      });
    } catch {
      return reply.status(502).send({ error: "Could not reach GitHub to complete sign-in." });
    }
    if (!tokenResponse.ok) {
      return reply.status(502).send({ error: "GitHub rejected the sign-in request." });
    }
    const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenBody.access_token) {
      return reply
        .status(502)
        .send({ error: `GitHub did not return an access token: ${tokenBody.error_description ?? tokenBody.error ?? "unknown reason"}` });
    }

    let userInfo: GitHubUserInfo;
    try {
      const userResponse = await fetch(USER_URL, {
        headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      });
      if (!userResponse.ok) throw new Error("user request failed");
      userInfo = (await userResponse.json()) as GitHubUserInfo;
    } catch {
      return reply.status(502).send({ error: "Could not fetch account details from GitHub." });
    }

    let email = userInfo.email?.toLowerCase() ?? null;
    if (!email) {
      try {
        const emailsResponse = await fetch(EMAILS_URL, {
          headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
        });
        if (emailsResponse.ok) {
          const emails = (await emailsResponse.json()) as GitHubEmailEntry[];
          const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
          email = primary?.email.toLowerCase() ?? null;
        }
      } catch {

      }
    }

    const currentUserId = resolveCurrentUserId(request, db);

    const providerUserId = String(userInfo.id);
    let identity = getOauthIdentity(db, "github", providerUserId);
    let userId: string;

    if (identity) {
      userId = identity.user_id;

      updateOauthTokens(db, identity.id, encryptToken(tokenBody.access_token), null);
    } else if (currentUserId) {

      userId = currentUserId;
      createOauthIdentity(db, randomUUID(), {
        userId,
        provider: "github",
        providerUserId,
        email,
        accessTokenEnc: encryptToken(tokenBody.access_token),
        refreshTokenEnc: null,
      });
    } else {
      const existingUser = email ? getUserByEmail(db, email) : undefined;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const created = createUser(db, randomUUID(), {
          email: email ?? `github-${userInfo.login}@users.codebase-engineer.local`,
          displayName: userInfo.name ?? userInfo.login,
          passwordHash: null,
        });
        userId = created.id;
      }
      createOauthIdentity(db, randomUUID(), {
        userId,
        provider: "github",
        providerUserId,
        email,
        accessTokenEnc: encryptToken(tokenBody.access_token),
        refreshTokenEnc: null,
      });
    }

    if (userId !== currentUserId) {
      const sessionToken = createSession(db, randomUUID(), userId);
      setSessionCookie(request, reply, sessionToken);
    }

    return reply.redirect("/");
  });
}
