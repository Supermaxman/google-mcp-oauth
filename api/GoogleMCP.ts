import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleService } from "./GoogleService.ts";
import { GoogleAuthContext } from "../types";

export class GoogleMCP extends McpAgent<Env, unknown, GoogleAuthContext> {
  async init() {}

  get googleService() {
    return new GoogleService(this.env, this.props.accessToken);
  }

  formatResponse = (description: string, data: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: `Success! ${description}\n\nResult:\n${JSON.stringify(
          data,
          null,
          2
        )}`,
      },
    ],
  });

  get server() {
    const server = new McpServer(
      {
        name: "Google Service",
        description: "Google MCP Server for Gmail and Calendar",
        version: "1.0.0",
      },
      {
        instructions:
          "This MCP server exposes Gmail and Google Calendar operations via Google APIs.",
      }
    );

    // Calendar tools
    server.tool(
      "getUserCalendarEvents",
      "Get the user's calendar events",
      {
        startDate: z.string().describe("Start date in ISO 8601"),
        endDate: z.string().describe("End date in ISO 8601"),
      },
      async ({ startDate, endDate }) => {
        const events = await this.googleService.getUserCalendarEvents(
          startDate,
          endDate
        );
        return this.formatResponse("Calendar events retrieved", events);
      }
    );

    server.tool(
      "createCalendarEvent",
      "Create a new calendar event for the user",
      {
        subject: z.string().describe("The event summary/subject"),
        startDate: z.string().describe("Start date/time ISO 8601"),
        endDate: z.string().describe("End date/time ISO 8601"),
        reminderMinutesBeforeStart: z
          .number()
          .default(15)
          .describe("Reminder lead time (ignored for now)"),
        body: z.string().optional().describe("Plaintext description"),
        location: z.string().optional().describe("Location or meeting link"),
        isAllDay: z.boolean().optional().describe("All-day event flag"),
        categories: z
          .array(z.string())
          .optional()
          .describe("Ignored by Google; kept for parity"),
        attendees: z.array(z.string()).optional().describe("Attendee emails"),
      },
      async (args) => {
        const event = await this.googleService.createCalendarEvent(
          args.subject,
          args.startDate,
          args.endDate,
          args.reminderMinutesBeforeStart,
          args.body,
          args.location,
          args.isAllDay,
          args.categories,
          args.attendees
        );
        return this.formatResponse("Calendar event created", event);
      }
    );

    server.tool(
      "deleteCalendarEvent",
      "Delete a calendar event for the user",
      { eventId: z.string().describe("Event ID") },
      async ({ eventId }) => {
        await this.googleService.deleteCalendarEvent(eventId);
        return this.formatResponse("Calendar event deleted", { eventId });
      }
    );

    server.tool(
      "getCalendarEvent",
      "Get a calendar event",
      { eventId: z.string().describe("Event ID") },
      async ({ eventId }) => {
        const event = await this.googleService.getCalendarEvent(eventId);
        return this.formatResponse("Calendar event retrieved", event);
      }
    );

    server.tool(
      "updateCalendarEvent",
      "Update a calendar event (partial)",
      {
        eventId: z.string(),
        subject: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        reminderMinutesBeforeStart: z.number().optional(),
        body: z.string().optional(),
        location: z.string().optional(),
        isAllDay: z.boolean().optional(),
        categories: z.array(z.string()).optional(),
        attendees: z.array(z.string()).optional(),
      },
      async ({ eventId, ...rest }) => {
        const event = await this.googleService.updateCalendarEvent(
          eventId,
          rest.subject,
          rest.startDate,
          rest.endDate,
          rest.reminderMinutesBeforeStart,
          rest.body,
          rest.location,
          rest.isAllDay,
          rest.categories,
          rest.attendees
        );
        return this.formatResponse("Calendar event updated", event);
      }
    );

    // Gmail tools
    server.tool(
      "searchEmails",
      "Search Gmail with optional filters and date range",
      {
        folder: z
          .enum(["inbox", "sentitems", "drafts", "archive"])
          .default("inbox"),
        startDate: z.string().describe("Start ISO 8601"),
        endDate: z.string().describe("End ISO 8601"),
        fromAddress: z.string().optional(),
        toAddress: z.string().optional(),
        conversationId: z
          .string()
          .optional()
          .describe("Ignored for Gmail search; use threadId when needed"),
        query: z.string().optional(),
      },
      async ({
        folder,
        startDate,
        endDate,
        fromAddress,
        toAddress,
        conversationId,
        query,
      }) => {
        const emails = await this.googleService.searchEmails(
          folder,
          startDate,
          endDate,
          fromAddress,
          toAddress,
          conversationId,
          query
        );
        return this.formatResponse("Emails retrieved", emails);
      }
    );

    server.tool(
      "markEmailAsRead",
      "Mark a Gmail message as read",
      { emailId: z.string() },
      async ({ emailId }) => {
        await this.googleService.markEmailAsRead(emailId);
        return this.formatResponse("Email marked as read", { emailId });
      }
    );

    server.tool(
      "archiveEmail",
      "Archive a Gmail message (remove from INBOX)",
      { emailId: z.string() },
      async ({ emailId }) => {
        const res = await this.googleService.archiveEmail(emailId);
        return this.formatResponse("Email archived", res);
      }
    );

    server.tool(
      "getEmail",
      "Get a Gmail message by ID",
      { emailId: z.string() },
      async ({ emailId }) => {
        const email = await this.googleService.getEmail(emailId);
        return this.formatResponse("Email retrieved", email);
      }
    );

    server.tool(
      "draftEmail",
      "Create a Gmail draft (plaintext)",
      {
        subject: z.string(),
        body: z.string(),
        toRecipients: z.array(z.string()).min(1),
        ccRecipients: z.array(z.string()).optional(),
        bccRecipients: z.array(z.string()).optional(),
      },
      async ({ subject, body, toRecipients, ccRecipients, bccRecipients }) => {
        const draft = await this.googleService.draftEmail(
          subject,
          body,
          toRecipients,
          ccRecipients,
          bccRecipients
        );
        return this.formatResponse("Draft created", draft);
      }
    );

    server.tool(
      "createReplyDraft",
      "Create a reply (or reply-all) draft to a message",
      {
        originalEmailId: z.string(),
        replyAll: z.boolean().optional().default(false),
        body: z.string().optional(),
      },
      async ({ originalEmailId, replyAll, body }) => {
        const draft = await this.googleService.createReplyDraft(
          originalEmailId,
          replyAll,
          body
        );
        return this.formatResponse("Reply draft created", draft);
      }
    );

    server.tool(
      "updateEmailDraft",
      "Replace content/recipients of an existing Gmail draft",
      {
        emailId: z.string().describe("Draft ID"),
        subject: z.string().optional(),
        body: z.string().optional(),
        toRecipients: z.array(z.string()).optional(),
        ccRecipients: z.array(z.string()).optional(),
        bccRecipients: z.array(z.string()).optional(),
      },
      async ({
        emailId,
        subject,
        body,
        toRecipients,
        ccRecipients,
        bccRecipients,
      }) => {
        const updated = await this.googleService.updateEmailDraft(
          emailId,
          subject,
          body,
          toRecipients,
          ccRecipients,
          bccRecipients
        );
        return this.formatResponse("Draft updated", updated);
      }
    );

    server.tool(
      "sendEmail",
      "Send a Gmail draft by ID",
      { emailId: z.string().describe("Draft ID") },
      async ({ emailId }) => {
        await this.googleService.sendEmail(emailId);
        return this.formatResponse("Email sent", { emailId });
      }
    );

    server.tool(
      "deleteEmail",
      "Delete a Gmail message by ID",
      { emailId: z.string() },
      async ({ emailId }) => {
        await this.googleService.deleteEmail(emailId);
        return this.formatResponse("Email deleted", { emailId });
      }
    );

    server.tool(
      "startGmailWatch",
      "Create a Gmail watch for new messages (requires Pub/Sub topic configuration)",
      {
        serverName: z.string().describe("MCP server name to tag notifications"),
      },
      async ({ serverName }) => {
        await this.googleService.startGmailWatch(serverName);
        return this.formatResponse("Gmail watch started", { serverName });
      }
    );

    server.tool(
      "listInboxAddsSince",
      "List all new messages in the INBOX since the last history ID",
      {
        lastProcessedHistoryId: z
          .string()
          .describe("Last history ID to process"),
      },
      async ({ lastProcessedHistoryId }) => {
        const { messageIds, latestHistoryId, hasMore } =
          await this.googleService.listInboxAddsSince(lastProcessedHistoryId);
        return this.formatResponse("Inbox messages retrieved", {
          messageIds,
          latestHistoryId,
          hasMore,
        });
      }
    );

    server.tool(
      "commitHistory",
      "Commit the history ID for a server to mark that we've processed all messages up to this point",
      {
        serverName: z.string().describe("MCP server name to tag notifications"),
        historyId: z.string().describe("History ID to commit"),
      },
      async ({ serverName, historyId }) => {
        await this.googleService.commitHistory(serverName, historyId);
        return this.formatResponse("History committed", {
          serverName,
          historyId,
        });
      }
    );

    return server;
  }
}
