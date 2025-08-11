import { GoogleMCP } from "./GoogleMCP.ts";
import {
  googleBearerTokenAuthMiddleware,
  getGoogleAuthEndpoint,
  exchangeCodeForToken as exchangeGoogleCodeForToken,
  refreshAccessToken as refreshGoogleAccessToken,
  GOOGLE_DEFAULT_SCOPES,
} from "./lib/google-auth.ts";
import { cors } from "hono/cors";
import { Hono } from "hono";
import type { WebhookResponse } from "../types";

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
      code_challenge_methods_supported: ["S256"],
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

    return c.redirect(googleAuthUrl.toString());
  })

  .post("/token", async (c) => {
    const body = await c.req.parseBody();
    if (body.grant_type === "authorization_code") {
      const result = await exchangeGoogleCodeForToken(
        body.code as string,
        body.redirect_uri as string,
        c.env.GOOGLE_CLIENT_ID,
        c.env.GOOGLE_CLIENT_SECRET,
        body.code_verifier as string | undefined
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

  // Google webhooks (Gmail via Pub/Sub push)
  // .route(
  //   "/webhooks",
  //   new Hono<{ Bindings: Env }>().post("/gmail", async (c) => {
  //     // Pub/Sub push format; base64-encoded message.data includes JSON { emailAddress, historyId }
  //     try {
  //       const body = await c.req.json<{
  //         message?: { data?: string; attributes?: Record<string, string> };
  //       }>();
  //       let emailAddress: string | undefined;
  //       let historyId: string | undefined;
  //       if (body.message?.data) {
  //         const json = JSON.parse((globalThis as any).atob(body.message.data));
  //         emailAddress = json.emailAddress;
  //         historyId = json.historyId;
  //       }
  //       // Fallback from attributes
  //       emailAddress = emailAddress ?? body.message?.attributes?.emailAddress;
  //       historyId = historyId ?? body.message?.attributes?.historyId;

  //       const name = c.req.header("x-mcp-name") ?? "gmail";
  //       const respData = { name, emailAddress, historyId };
  //       const response: WebhookResponse = {
  //         reqResponseCode: 204,
  //         reqResponseContent: "",
  //         reqResponseContentType: "text",
  //         promptContent: `Gmail notification received.\n\n\`\`\`json\n${JSON.stringify(
  //           respData,
  //           null,
  //           2
  //         )}\n\`\`\``,
  //       };
  //       return c.json(response);
  //     } catch (e) {
  //       return c.json({ error: "Invalid Pub/Sub push payload" }, 400);
  //     }
  //   })
  // )

  // Health check endpoint
  .get("/", (c) => c.text("MCP Server is running (Google)"));
