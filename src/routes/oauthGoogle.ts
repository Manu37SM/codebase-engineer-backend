import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getGoogleOAuthConfig } from "../auth/oauthConfig.js";
import { beginOAuthState, verifyAndClearOAuthState } from "../auth/oauthState.js";
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
// Task #86: adds Drive read access so a signed-in user can browse their own
// Drive for a zip file to import (`routes/googleDrive.ts`). `drive.readonly`
// is deliberately broader than "just the files this app created"
// (`drive.file`) because `drive.file` can only see files the app itself
// created/opened via the picker UI — it cannot list or search a user's
// *existing* zip files by mimetype, which is exactly what Task #86 needs
// without pulling in Google's separate client-side Picker JS widget. Same
// "broad scope is the tradeoff for browsing existing files without a
// picker widget" reasoning already used for GitHub's `repo` scope
// (Task #83/#84) — still local-first: the token only ever downloads bytes
// onto this same machine, nothing is stored or proxied server-side beyond
// the encrypted token itself.
const SCOPES = "openid email profile https://www.googleapis.com/auth/drive.readonly";

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Google sign-in (Task #82) — authentication only, per the user's explicit
 * architecture instruction ("GitHub OAuth is only for authentication and
 * repository access... Do not redesign it as a hosted multi-user SaaS").
 * Standard OAuth 2.0 authorization-code flow: /start redirects to Google,
 * /callback exchanges the code, fetches the account's stable Google `sub`
 * + email, and either links to an existing local account (matched by
 * email) or creates a new passwordless one, then logs the browser in with
 * the normal session cookie (`auth/session.ts`, shared with local
 * email/password login).
 */
export function registerGoogleOAuthRoutes(app: FastifyInstance, { db }: RegisterGoogleOAuthRoutesOptions): void {
  app.get("/api/v1/auth/google/start", async (request, reply) => {
    const config = getGoogleOAuthConfig();
    if (!config) {
      return reply
        .status(404)
        .send({ error: "Google sign-in is not configured on this server. See backend/.env.example / docs/AUTH.md." });
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

    let identity = getOauthIdentity(db, "google", userInfo.sub);
    let userId: string;

    if (identity) {
      userId = identity.user_id;
      // Refresh the stored (encrypted) tokens on every login — Google only
      // returns a refresh_token on the FIRST consent, so a missing one here
      // just means "keep whatever we already had", not "clear it".
      updateOauthTokens(
        db,
        identity.id,
        encryptToken(tokenBody.access_token),
        tokenBody.refresh_token ? encryptToken(tokenBody.refresh_token) : null
      );
    } else {
      // No identity linked yet — link to an existing local account with the
      // same email if one exists (so someone who registered with
      // alice@example.com/password and later clicks "Sign in with Google"
      // using the same address lands in the same account), otherwise create
      // a brand-new passwordless account for this Google identity.
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

    const sessionToken = createSession(db, randomUUID(), userId);
    setSessionCookie(request, reply, sessionToken);

    // Redirect back into the SPA rather than returning JSON — this is a
    // real browser navigation (the user just came back from Google's
    // consent screen), not an API call a script is awaiting.
    return reply.redirect("/");
  });
}
