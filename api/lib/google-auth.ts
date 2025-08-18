import { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { GoogleAuthContext } from "../../types";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

function audMatchesPrefix(aud: string, prefix: string): boolean {
  try {
    const a = new URL(aud);
    const p = new URL(prefix);
    if (a.origin.toLowerCase() !== p.origin.toLowerCase()) return false;
    const strip = (s: string) => s.replace(/\/+$/, "");
    const ap = strip(a.pathname);
    const pp = strip(p.pathname);
    const okPath = ap === pp || ap.startsWith(pp + "/"); // /api/webhooks or /api/webhooks/...
    const noQsHash = !a.search && !a.hash; // optional hardening
    return okPath && noQsHash;
  } catch {
    // If audience isn't a URL, follow stated policy (prefix match).
    // If you only ever expect URLs, consider returning false instead.
    return aud.startsWith(prefix);
  }
}

function audiencesFromClaim(claim: unknown): string[] {
  if (typeof claim === "string") return [claim];
  if (Array.isArray(claim))
    return claim.filter((x): x is string => typeof x === "string");
  return [];
}

export async function verifyPubSubIdToken(
  idToken: string,
  expectedEmail: string,
  audPrefix: string
) {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    algorithms: ["RS256"],
    clockTolerance: "60s",
  });

  // Enforce audience against your prefix policy (handles string | string[])
  const audiences = audiencesFromClaim(payload.aud);
  const audOk = audiences.some((a) => audMatchesPrefix(a, audPrefix));
  if (!audOk) {
    throw new Error(`Invalid audience: got ${audiences.join(", ")}`);
  }

  // Enforce signer identity
  const email = String(payload.email ?? "");
  const verified =
    payload.email_verified === true || payload.email_verified === "true";
  if (email !== expectedEmail || !verified) {
    throw new Error(
      `Email mismatch or not verified: got ${email}, expected ${expectedEmail}`
    );
  }

  return payload; // safe claims
}

type OidcOpts = {
  serviceAccountEmail?: string | ((c: Context) => string);
};

type PubSubClaims = {
  iss: string;
  aud: string | string[];
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
    // --- Authorization header ---
    const auth = c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      c.header("WWW-Authenticate", 'Bearer realm="pubsub"');
      console.log("missing or invalid bearer token");
      throw new HTTPException(401, {
        message: "Missing or invalid bearer token",
      });
    }
    const idToken = auth.slice(7).trim();

    // --- Resolve config ---
    const audPrefix = c.env.GOOGLE_TOKEN_AUDIENCE_PREFIX;
    if (!audPrefix) {
      console.log("GOOGLE_TOKEN_AUDIENCE_PREFIX is not set");
      throw new HTTPException(500, {
        message: "Server misconfigured: missing GOOGLE_TOKEN_AUDIENCE_PREFIX",
      });
    }

    const configuredEmail =
      typeof opts.serviceAccountEmail === "function"
        ? opts.serviceAccountEmail(c)
        : opts.serviceAccountEmail;

    if (!configuredEmail) {
      console.log(
        "Missing service account email (opts or GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT)"
      );
      throw new HTTPException(500, {
        message: "Server misconfigured: missing service account email",
      });
    }

    // --- Verify token locally ---
    try {
      const claims = (await verifyPubSubIdToken(
        idToken,
        configuredEmail,
        audPrefix
      )) as unknown as PubSubClaims;
      c.set("pubsubClaims", claims);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid id_token";
      c.header(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="${msg.replace(
          /"/g,
          "'"
        )}"`
      );
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      console.log(`id_token verification failed: ${msg}`);
      throw new HTTPException(401, { message: "Invalid id_token" });
    }

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
