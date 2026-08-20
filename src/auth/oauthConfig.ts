/**
 * Reads Google/GitHub OAuth app credentials from the environment (Task
 * #82/#83). Each provider is entirely optional and independent — e.g. you
 * can configure GitHub without Google. `null` (not throwing) when a
 * provider isn't (fully) configured, so the `/start` route for that
 * provider can return a clear "not configured" response instead of the
 * server crashing on startup — same "additive, never a hard requirement"
 * shape as Razorpay billing (`billing/config.ts`) and Turnstile
 * (`auth/turnstile.ts`).
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleOAuthConfig(): OAuthProviderConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/api/v1/auth/google/callback";
  return { clientId, clientSecret, redirectUri };
}

export function getGitHubOAuthConfig(): OAuthProviderConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.GITHUB_REDIRECT_URI || "http://localhost:4000/api/v1/auth/github/callback";
  return { clientId, clientSecret, redirectUri };
}
