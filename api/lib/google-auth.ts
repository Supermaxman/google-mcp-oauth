import { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { decode } from "hono/jwt";
import type { GoogleAuthContext } from "../../types";

type OidcOpts = {
  /**
   * Expected audience (aud) — MUST match the value you set with:
   *   --push-auth-token-audience="https://chat.aiescape.io/.../email-notify"
   * You can pass a string or a function to compute it from the request.
   * Defaults to `c.req.url`.
   */
  audience?: string | ((c: Context) => string);

  /**
   * The service account email that Pub/Sub uses to sign the OIDC token,
   * i.e. the same one you passed to:
   *   --push-auth-service-account="push-invoker-...@PROJECT_ID.iam.gserviceaccount.com"
   * You can pass a string or a function to compute it (e.g., by x-mcp-name).
   * Defaults to env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT.
   */
  serviceAccountEmail?: string | ((c: Context) => string);
};

type PubSubClaims = {
  iss: string;
  aud: string;
  email: string;
  email_verified: string | boolean;
  exp?: number | string;
  [k: string]: unknown;
};

export const googlePubSubOidcAuthMiddleware = (opts: OidcOpts = {}) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { pubsubClaims: PubSubClaims };
  }>(async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      c.header("WWW-Authenticate", 'Bearer realm="pubsub"');
      console.log("missing or invalid bearer token");
      throw new HTTPException(401, {
        message: "Missing or invalid bearer token",
      });
    }

    const idToken = auth.slice(7).trim();

    // Optional quick local exp check to short-circuit obviously stale tokens
    try {
      const decoded = decode(idToken);
      const exp = (decoded?.payload as any)?.exp as number | undefined;
      if (exp && exp < Date.now() / 1000 + 30) {
        c.header(
          "WWW-Authenticate",
          'Bearer error="invalid_token", error_description="The id_token is expired"'
        );
        c.header("Cache-Control", "no-store");
        c.header("Pragma", "no-cache");
        console.log("expired id_token");
        throw new HTTPException(401, { message: "Expired id_token" });
      }
    } catch {
      // If decode fails, we’ll still attempt remote verification below
    }

    // Resolve expectations
    const expectedAudience =
      typeof opts.audience === "function"
        ? opts.audience(c)
        : opts.audience || c.req.url;

    const configuredEmail =
      typeof opts.serviceAccountEmail === "function"
        ? opts.serviceAccountEmail(c)
        : opts.serviceAccountEmail;

    if (!configuredEmail) {
      console.log(
        "server misconfigured: GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT or serviceAccountEmail resolver is required"
      );
      throw new HTTPException(500, {
        message:
          "Server misconfigured: GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT or serviceAccountEmail resolver is required",
      });
    }

    // Verify via Google tokeninfo (validates signature, issuer, etc.)
    const verifyResp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
        idToken
      )}`
    );

    if (!verifyResp.ok) {
      console.log(
        `invalid id_token: ${verifyResp.statusText} ${verifyResp.status}`
      );
      try {
        const errorBody = await verifyResp.text();
        console.log(`errorBody: ${errorBody}`);
      } catch (e) {
        console.log(`errorBody: ${e}`);
      }
      throw new HTTPException(401, { message: "Invalid id_token" });
    }

    const claims = (await verifyResp.json()) as PubSubClaims;

    // Enforce claims
    if (claims.iss !== "https://accounts.google.com") {
      console.log(`invalid issuer: ${claims.iss}`);
      throw new HTTPException(401, { message: "Invalid issuer" });
    }
    if (claims.aud !== expectedAudience) {
      console.log(`invalid audience: got ${claims.aud}`);
      throw new HTTPException(401, {
        message: `Invalid audience: got ${claims.aud}`,
      });
    }
    if (claims.email !== configuredEmail) {
      console.log(`invalid signer email: got ${claims.email}`);
      throw new HTTPException(401, {
        message: `Invalid signer email: got ${claims.email}`,
      });
    }
    const verified =
      claims.email_verified === true || claims.email_verified === "true";
    if (!verified) {
      console.log(`service account email not verified: ${claims.email}`);
      throw new HTTPException(401, {
        message: "Service account email not verified",
      });
    }

    // Stash claims for downstream handler(s)
    c.set("pubsubClaims", claims);

    await next();
  });

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
  Variables: { googleAuth: GoogleAuthContext };
}>(async (c, next) => {
  const auth = c.req.header("Authorization");

  if (!auth) {
    c.header("WWW-Authenticate", 'Bearer realm="api"');
    console.log("missing or invalid access token");
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }
  if (!auth.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", 'Bearer realm="api"');
    console.log("missing or invalid access token");
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }

  // Slice off "Bearer "
  const accessToken = auth.slice(7).trim();

  if (!accessToken) {
    c.header("WWW-Authenticate", 'Bearer realm="api"');
    console.log("missing or invalid access token");
    throw new HTTPException(401, {
      message: "Missing or invalid access token",
    });
  }

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
  c.set("googleAuth", { accessToken });
  await next();
});
