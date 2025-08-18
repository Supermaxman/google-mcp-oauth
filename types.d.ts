// Environment variables and bindings
interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_PROJECT_NAME?: string; // Pub/Sub topic resource name for Gmail watch
  GOOGLE_TOKEN_AUDIENCE_PREFIX: string;
  GOOGLE_MCP_OBJECT: DurableObjectNamespace;
  GMAIL_HISTORY_KV: KVNamespace;
}

export type Todo = {
  id: string;
  text: string;
  completed: boolean;
};

// Context from the auth process, extracted from the Stytch auth token JWT
// and provided to the MCP Server as this.props
type AuthenticationContext = {
  claims: {
    iss: string;
    scope: string;
    sub: string;
    aud: string[];
    client_id: string;
    exp: number;
    iat: number;
    nbf: number;
    jti: string;
  };
  accessToken: string;
};

// Context from the Google OAuth process
export type GoogleAuthContext = {
  accessToken: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
};

export type EmailProcessData = {
  emailAddress: string;
  historyId: string;
};

// Webhook response contract for proxied webhook handling
export type WebhookResponse<T> = {
  /** HTTP status code to proxy back to the origin of the webhook */
  reqResponseCode: number;
  /** body string to proxy back; if JSON, stringify it */
  reqResponseContent: string;
  /** content type for reqResponseContent: "json" or "text" */
  reqResponseContentType?: "json" | "text";
  /** optional return to run with the agent to do something */
  processData?: T;
};

export type WebhookProcessResponse = {
  promptContent?: string;
};
