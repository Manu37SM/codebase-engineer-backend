import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getGoogleOAuthConfig } from "../auth/oauthConfig.js";
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

interface RegisterGoogleOAuthRoutesOptions {
  db: DB;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES = "openid email profile https://www.googleapis.com/auth/drive.readonly";

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export function registerGoogleOAuthRoutes(app: FastifyInstance, { db }: RegisterGoogleOAuthRoutesOptions): void {
  app.get("/api/v1/auth/google/start", async (request, reply) => {
    const config = getGoogleOAuthConfig();
    if (!config) {
      return reply
        .status(404)
        .send({ error: "Google sign-in is not configured on this server. See backend/.env.example." });
    }

    const state = beginOAuthState(request, reply, "google");
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");

    return reply.redirect(url.toString());
  });

  app.get("/api/v1/auth/google/callback", async (request, reply) => {
    const config = getGoogleOAuthConfig();
    if (!config) {
      return reply.status(404).send({ error: "Google sign-in is not configured on this server." });
    }

    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.status(400).send({ error: `Google sign-in was cancelled or failed: ${query.error}` });
    }
    if (!verifyAndClearOAuthState(request, reply, "google", query.state)) {
      return reply.status(400).send({ error: "Invalid or expired sign-in request — please try again." });
    }
    if (!query.code) {
      return reply.status(400).send({ error: "Google did not return an authorization code." });
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }),
      });
    } catch {
      return reply.status(502).send({ error: "Could not reach Google to complete sign-in." });
    }
    if (!tokenResponse.ok) {
      return reply.status(502).send({ error: "Google rejected the sign-in request." });
    }
    const tokenBody = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!tokenBody.access_token) {
      return reply.status(502).send({ error: "Google did not return an access token." });
    }

    let userInfo: GoogleUserInfo;
    try {
      const userInfoResponse = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      });
      if (!userInfoResponse.ok) throw new Error("userinfo request failed");
      userInfo = (await userInfoResponse.json()) as GoogleUserInfo;
    } catch {
      return reply.status(502).send({ error: "Could not fetch account details from Google." });
    }
    if (!userInfo.sub) {
      return reply.status(502).send({ error: "Google did not return a stable account id." });
    }

    const currentUserId = resolveCurrentUserId(request, db);

    let identity = getOauthIdentity(db, "google", userInfo.sub);
    let userId: string;

    if (identity) {
      userId = identity.user_id;

      updateOauthTokens(
        db,
        identity.id,
        encryptToken(tokenBody.access_token),
        tokenBody.refresh_token ? encryptToken(tokenBody.refresh_token) : null
      );
    } else if (currentUserId) {

      userId = currentUserId;
      const email = userInfo.email?.toLowerCase() ?? null;
      createOauthIdentity(db, randomUUID(), {
        userId,
        provider: "google",
        providerUserId: userInfo.sub,
        email,
        accessTokenEnc: encryptToken(tokenBody.access_token),
        refreshTokenEnc: tokenBody.refresh_token ? encryptToken(tokenBody.refresh_token) : null,
      });
    } else {

      const email = userInfo.email?.toLowerCase() ?? null;
      const existingUser = email ? getUserByEmail(db, email) : undefined;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const created = createUser(db, randomUUID(), {
          email: email ?? `google-${userInfo.sub}@users.codebase-engineer.local`,
          displayName: userInfo.name ?? null,
          passwordHash: null,
        });
        userId = created.id;
      }
      createOauthIdentity(db, randomUUID(), {
        userId,
        provider: "google",
        providerUserId: userInfo.sub,
        email,
        accessTokenEnc: encryptToken(tokenBody.access_token),
        refreshTokenEnc: tokenBody.refresh_token ? encryptToken(tokenBody.refresh_token) : null,
      });
    }

    if (userId !== currentUserId) {
      const sessionToken = createSession(db, randomUUID(), userId);
      setSessionCookie(request, reply, sessionToken);
    }

    return reply.redirect("/");
  });
}
