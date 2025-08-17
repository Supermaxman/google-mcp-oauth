import { GoogleMCP } from "./GoogleMCP.ts";
import {
  googleBearerTokenAuthMiddleware,
  getGoogleAuthEndpoint,
  exchangeCodeForToken as exchangeGoogleCodeForToken,
  refreshAccessToken as refreshGoogleAccessToken,
  GOOGLE_DEFAULT_SCOPES,
  googlePubSubOidcAuthMiddleware,
} from "./lib/google-auth.ts";
import { cors } from "hono/cors";
import { Hono } from "hono";
import type { WebhookResponse } from "../types";
import { getServerCursor, putServerCursor } from "./lib/kv-helpers.ts";
import { GoogleService } from "./GoogleService.ts";

// Export the GoogleMCP class so the Worker runtime can find it
export { GoogleMCP };

interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope?: string;
  token_endpoint_auth_method: string;
  created_at: number;
}
const registeredClients = new Map<string, RegisteredClient>();

function saEmailFor(c: any) {
  const name = c.req.header("x-mcp-name");
  return `push-invoker-${name}@${c.env.GOOGLE_PROJECT_NAME}.iam.gserviceaccount.com`;
}

export default new Hono<{ Bindings: Env }>()
  .use(cors())

  // ---------- Google OAuth ----------
  .get("/.well-known/oauth-authorization-server", async (c) => {
    const url = new URL(c.req.url);
    return c.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
      registration_endpoint: `${url.origin}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256", "plain"],
      scopes_supported: GOOGLE_DEFAULT_SCOPES,
    });
  })

  // Dynamic Client Registration endpoint
  .post("/register", async (c) => {
    const body = await c.req.json();

    // Generate a client ID
    const clientId = crypto.randomUUID();

    // Store the client registration
    registeredClients.set(clientId, {
      client_id: clientId,
      client_name: body.client_name || "MCP Client",
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ["authorization_code", "refresh_token"],
      response_types: body.response_types || ["code"],
      scope: body.scope,
      token_endpoint_auth_method: "none",
      created_at: Date.now(),
    });

    // Return the client registration response
    return c.json(
      {
        client_id: clientId,
        client_name: body.client_name || "MCP Client",
        redirect_uris: body.redirect_uris || [],
        grant_types: body.grant_types || [
          "authorization_code",
          "refresh_token",
        ],
        response_types: body.response_types || ["code"],
        scope: body.scope,
        token_endpoint_auth_method: "none",
      },
      201
    );
  })

  .get("/authorize", async (c) => {
    const url = new URL(c.req.url);
    const googleAuthUrl = new URL(getGoogleAuthEndpoint("authorize"));

    // Forward query params except client_id/scope; set ours
    url.searchParams.forEach((value, key) => {
      if (key !== "client_id" && key !== "scope") {
        googleAuthUrl.searchParams.set(key, value);
      }
    });
    googleAuthUrl.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
    // Default scope if not provided
    const scope =
      url.searchParams.get("scope") ?? GOOGLE_DEFAULT_SCOPES.join(" ");
    googleAuthUrl.searchParams.set("scope", scope);
    // Ensure response_type is code
    if (!googleAuthUrl.searchParams.get("response_type")) {
      googleAuthUrl.searchParams.set("response_type", "code");
    }

    // If client set a code_challenge but omitted the method, default to S256
    if (
      googleAuthUrl.searchParams.get("code_challenge") &&
      !googleAuthUrl.searchParams.get("code_challenge_method")
    ) {
      googleAuthUrl.searchParams.set("code_challenge_method", "S256");
    }

    // Ensure offline access so Google will issue refresh_token
    if (!googleAuthUrl.searchParams.get("access_type")) {
      googleAuthUrl.searchParams.set("access_type", "offline");
    }
    // Prompt consent if caller didn't specify; helps receive refresh_token
    if (!googleAuthUrl.searchParams.get("prompt")) {
      googleAuthUrl.searchParams.set("prompt", "consent");
    }
    // Enable incremental auth behavior by default
    if (!googleAuthUrl.searchParams.get("include_granted_scopes")) {
      googleAuthUrl.searchParams.set("include_granted_scopes", "true");
    }

    const m = googleAuthUrl.searchParams.get("code_challenge_method"); // 'S256' | 'plain' | null
    const cc = googleAuthUrl.searchParams.get("code_challenge");
    const ru = googleAuthUrl.searchParams.get("redirect_uri");
    console.log("PKCE authorize:", {
      method: m,
      code_challenge: cc?.slice(0, 8) + "…",
      redirect_uri: ru,
    });

    return c.redirect(googleAuthUrl.toString());
  })

  .post("/token", async (c) => {
    const body = await c.req.parseBody();
    const cv = body.code_verifier as string | undefined;
    console.log("PKCE token:", {
      code_verifier: cv?.slice(0, 8) + "…",
      redirect_uri: body.redirect_uri,
      grant_type: body.grant_type,
      refresh_token: body.refresh_token
        ? (body.refresh_token as string).length
        : undefined,
      scope: body.scope,
    });

    try {
      if (body.grant_type === "authorization_code") {
        const result = await exchangeGoogleCodeForToken(
          body.code as string,
          body.redirect_uri as string,
          c.env.GOOGLE_CLIENT_ID,
          c.env.GOOGLE_CLIENT_SECRET,
          body.code_verifier as string | undefined,
          (body.scope as string | undefined) ||
            (typeof body.scope === "string"
              ? (body.scope as string)
              : undefined)
        );
        return c.json(result);
      } else if (body.grant_type === "refresh_token") {
        const result = await refreshGoogleAccessToken(
          body.refresh_token as string,
          c.env.GOOGLE_CLIENT_ID,
          c.env.GOOGLE_CLIENT_SECRET
        );
        return c.json(result);
      }
    } catch (err) {
      // Pass through OAuth errors from Google
      const e = err as unknown as {
        status?: number;
        body?: unknown;
        name?: string;
      };
      if (e && e.name === "OAuthHttpError") {
        const allowedStatuses = [
          400, 401, 403, 404, 405, 409, 410, 415, 422, 429, 500, 502, 503, 504,
        ] as const;
        const statusCandidate = (e.status as number) || 400;
        const status = (allowedStatuses as readonly number[]).includes(
          statusCandidate
        )
          ? (statusCandidate as
              | 400
              | 401
              | 403
              | 404
              | 405
              | 409
              | 410
              | 415
              | 422
              | 429
              | 500
              | 502
              | 503
              | 504)
          : (400 as const);
        return c.json(e.body ?? { error: "invalid_request" }, { status });
      }
      throw err;
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  })

  // Google MCP endpoints
  .use("/sse/*", googleBearerTokenAuthMiddleware)
  .route(
    "/sse",
    new Hono().mount(
      "/",
      GoogleMCP.serveSSE("/sse", { binding: "GOOGLE_MCP_OBJECT" }).fetch
    )
  )
  .use("/mcp", googleBearerTokenAuthMiddleware)
  .route(
    "/mcp",
    new Hono().mount(
      "/",
      GoogleMCP.serve("/mcp", { binding: "GOOGLE_MCP_OBJECT" }).fetch
    )
  )
  .use(
    "/webhooks",
    googlePubSubOidcAuthMiddleware({
      audience: (c) => c.req.url,
      serviceAccountEmail: saEmailFor,
    })
  )
  // Google webhooks (Gmail via Pub/Sub push)
  .route(
    "/webhooks",
    new Hono<{ Bindings: Env }>().post("/email-notify", async (c) => {
      // Pub/Sub push format; base64-encoded message.data includes JSON { emailAddress, historyId }
      try {
        // At this point the request is verified by the middleware.

        // Pub/Sub envelope
        const body = await c.req.json<{
          message?: {
            data?: string;
            attributes?: Record<string, string>;
            publishTime?: string;
          };
        }>();

        console.log("body", body);

        // Decode base64url payload
        const b64 = body.message?.data ?? "";
        const std = b64.replace(/-/g, "+").replace(/_/g, "/");
        const pad = std.length % 4 ? 4 - (std.length % 4) : 0;
        const decoded = atob(std + "=".repeat(pad));
        let emailAddress: string | undefined;
        let historyId: string | undefined;

        try {
          const payload = JSON.parse(decoded);
          emailAddress = payload.emailAddress;
          historyId = payload.historyId;
          console.log("payload", payload);
        } catch {
          // some libs may duplicate these in attributes
        }
        emailAddress = emailAddress ?? body.message?.attributes?.emailAddress;
        historyId = historyId ?? body.message?.attributes?.historyId;
        // const publishTime = body.message?.publishTime;

        // You asked to return server name + message IDs (if available) + email (if present).
        // If you haven’t wired history listing yet, just return the basics.
        const server = c.req.header("x-mcp-name");
        if (!server) {
          console.log("missing server name");
          return c.json({ error: "missing server name" }, 400);
        }

        console.log("server", server);
        console.log("emailAddress", emailAddress);

        const authHeader = c.req.header("x-mcp-authorization");
        if (!authHeader) {
          console.log("missing MCP authorization header");
          return c.json({ error: "missing MCP authorization header" }, 400);
        }

        // Slice off "Bearer "
        const accessToken = authHeader.slice(7).trim();

        if (!accessToken) {
          console.log("missing access token");
          return c.json({ error: "missing access token" }, 400);
        }
        const latestHistoryId = `${historyId}`;
        const lastHistoryId = await getServerCursor(c.env, server);

        if (!lastHistoryId) {
          console.log("missing last processed history ID");
          return c.json({ error: "missing last processed history ID" }, 400);
        }

        console.log("lastHistoryId", lastHistoryId);
        console.log("latestHistoryId", latestHistoryId);

        const api = new GoogleService(c.env, accessToken);
        console.log("accessToken", accessToken.slice(0, 12) + "…");

        const {
          messageIds,
          latestHistoryId: newLatestHistoryId,
          hasMore,
        } = await api.listInboxAddsSince(lastHistoryId);

        console.log("newLatestHistoryId", newLatestHistoryId);
        console.log("hasMore", hasMore);

        // TODO consider using the newLatestHistoryId instead of latestHistoryId
        console.log(`fast forward from ${lastHistoryId} to ${latestHistoryId}`);
        // preemptively update the cursor so we don't repeat processing, not end of the world if we miss a few
        await putServerCursor(c.env, server, latestHistoryId);

        if (messageIds.length === 0) {
          console.log("no new messages");
          const response: WebhookResponse = {
            reqResponseCode: 202, // your orchestrator will return 202 to Pub/Sub
            reqResponseContent: "",
            reqResponseContentType: "text",
          };
          return c.json(response, 200);
        }
        console.log(`${messageIds.length} new messages`);

        const respData = {
          name: server,
          emailAddress: emailAddress,
          emailIds: messageIds,
        };

        const response: WebhookResponse = {
          reqResponseCode: 202, // your orchestrator will return 202 to Pub/Sub
          reqResponseContent: "",
          reqResponseContentType: "text",
          promptContent: `Google email notification received:\n\n\`\`\`json\n${JSON.stringify(
            respData,
            null,
            2
          )}\n\`\`\``,
        };

        return c.json(response, 200);
      } catch (e: any) {
        console.error("error processing webhook", e);
        // If this throws, Pub/Sub will retry. Only 4xx when truly malformed.
        return c.json(
          { error: e?.message ?? "Invalid Pub/Sub push payload" },
          400
        );
      }
    })
  )

  // Health check endpoint
  .get("/", (c) => c.text("Google MCP Server is running"));
