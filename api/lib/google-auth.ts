import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { decode } from "hono/jwt";

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

export class OAuthHttpError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "OAuthHttpError";
    this.status = status;
    this.body = body;
  }
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
  scope?: string
): Promise<TokenResponse> {
  const body = form({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope,
    code_verifier: codeVerifier,
  });

  const res = await fetch(getGoogleAuthEndpoint("token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const isJson = (res.headers.get("content-type") || "").includes(
      "application/json"
    );
    const errorBody = isJson
      ? await res.json().catch(() => ({ error: "server_error" }))
      : {
          error: "server_error",
          error_description: await res.text().catch(() => ""),
        };
    throw new OAuthHttpError(
      "Token exchange failed",
      res.status || 400,
      errorBody
    );
  }
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
  if (!res.ok) {
    const isJson = (res.headers.get("content-type") || "").includes(
      "application/json"
    );
    const errorBody = isJson
      ? await res.json().catch(() => ({ error: "server_error" }))
      : {
          error: "server_error",
          error_description: await res.text().catch(() => ""),
        };
    throw new OAuthHttpError("Refresh failed", res.status || 400, errorBody);
  }
  return (await res.json()) as TokenResponse;
}

export const googleBearerTokenAuthMiddleware = createMiddleware<{
  Bindings: Env;
}>(async (c, next) => {
  const auth = c.req.header("Authorization");

  if (!auth) {
    c.header("WWW-Authenticate", 'Bearer realm="api"');
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }
  if (!auth.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", 'Bearer realm="api"');
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }

  // Slice off "Bearer "
  const accessToken = auth.slice(7);

  // Google doesn't use standard JWT tokens with expiry info, so we can't check for expiration
  // // check if the access token is expired
  // // gives header and payload
  // const decodedToken = decode(accessToken);
  // // make sure the token is not expired or about to expire within 1 minute
  // if (
  //   decodedToken.payload.exp &&
  //   decodedToken.payload.exp < Date.now() / 1000 + 60
  // ) {
  //   c.header(
  //     "WWW-Authenticate",
  //     'Bearer error="invalid_token", error_description="The access token expired"'
  //   );
  //   c.header("Cache-Control", "no-store");
  //   c.header("Pragma", "no-cache");
  //   throw new HTTPException(401, {
  //     message: "Access token expired",
  //   });
  // }
  // @ts-expect-error Worker executionCtx props
  c.executionCtx.props = { accessToken };
  await next();
});
