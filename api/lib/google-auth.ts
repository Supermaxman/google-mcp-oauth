import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

export const GOOGLE_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  // Gmail read/modify + send
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  // Calendar events read/write
  "https://www.googleapis.com/auth/calendar.events",
];

export function getGoogleAuthEndpoint(endpoint: "authorize" | "token"): string {
  if (endpoint === "authorize") {
    return "https://accounts.google.com/o/oauth2/v2/auth";
  }
  return "https://oauth2.googleapis.com/token";
}

type TokenResponse = {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
};

function form(params: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) body.append(k, v);
  });
  return body;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string | undefined,
  codeVerifier?: string,
  scopes: string[] = GOOGLE_DEFAULT_SCOPES
): Promise<TokenResponse> {
  const body = form({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    code_verifier: codeVerifier,
  });

  const res = await fetch(getGoogleAuthEndpoint("token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok)
    throw new Error(`Google token exchange failed: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
  scopes: string[] = GOOGLE_DEFAULT_SCOPES
): Promise<TokenResponse> {
  const body = form({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });

  const res = await fetch(getGoogleAuthEndpoint("token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Google refresh failed: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export const googleBearerTokenAuthMiddleware = createMiddleware<{
  Bindings: Env;
}>(async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }

  const accessToken = auth.slice(7);
  const refreshToken = c.req.header("X-Google-Refresh-Token") ?? "";
  // @ts-expect-error Worker executionCtx props
  c.executionCtx.props = { accessToken, refreshToken };
  await next();
});
