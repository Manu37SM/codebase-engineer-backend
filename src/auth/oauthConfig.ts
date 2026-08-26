

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
