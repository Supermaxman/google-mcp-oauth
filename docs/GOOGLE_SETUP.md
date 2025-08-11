Google OAuth + Gmail Push Setup

1) Create Google OAuth credentials
- Create an OAuth 2.0 Client ID in Google Cloud Console.
- Application type: Web application.
- Add your app’s redirect URIs used by the Agent/client (the Worker proxies `/authorize` → Google, then Google will redirect back to the client’s redirect URI you pass along).
- Copy the Client ID and Client Secret and set env vars `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

2) Scopes used
- `openid profile email`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/calendar.events`

3) Gmail push notifications (Pub/Sub)
- Create a Pub/Sub topic (example: `projects/PROJECT_ID/topics/gmail-notify`).
- Grant the Gmail publisher service account `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic.
- Create a Pub/Sub subscription on that topic. Use push delivery to your Worker endpoint `https://<your-host>/webhooks/gmail`.
- Set `GOOGLE_GMAIL_TOPIC_NAME` to the topic’s full resource name, e.g. `projects/PROJECT_ID/topics/gmail-notify`.
- From the MCP tool `startGmailWatch`, call to start a Gmail watch. Gmail will publish events to the topic; Pub/Sub will push to your webhook.

Notes
- Gmail does not support direct webhooks; all notifications are via Pub/Sub (push works like webhooks).
- Calendar webhooks are not required here; the MCP exposes Calendar CRUD via REST.

