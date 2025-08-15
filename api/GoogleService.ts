/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { putServerCursor } from "./lib/kv-helpers";

// ambient declarations for Web-available helpers in Workers
declare const btoa: (s: string) => string;

export class GoogleService {
  private env: Env;
  private accessToken: string;
  private gmailBase = "https://gmail.googleapis.com/gmail/v1";
  private calendarBase = "https://www.googleapis.com/calendar/v3";
  private userId = "me"; // Google APIs support special alias "me" for the current user

  constructor(env: Env, accessToken: string) {
    this.env = env;
    console.log(`init accessToken: ${accessToken}`);
    this.accessToken = accessToken;
  }

  private async makeRequest<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API error ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  /* ----------------------- Calendar ----------------------- */
  async getUserCalendarEvents(startDate: string, endDate: string) {
    const url = new URL(`${this.calendarBase}/calendars/primary/events`);
    url.searchParams.set("timeMin", startDate);
    url.searchParams.set("timeMax", endDate);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    const data = await this.makeRequest<any>(url.toString());
    return data.items ?? [];
  }

  async createCalendarEvent(
    subject: string,
    startDate: string,
    endDate: string,
    _reminderMinutesBeforeStart: number,
    body?: string,
    location?: string,
    isAllDay?: boolean,
    _categories?: string[],
    attendees?: string[]
  ) {
    const event: any = {
      summary: subject,
      description: body,
      location,
      attendees: attendees?.map((email) => ({ email })) ?? undefined,
    };
    if (isAllDay) {
      // All-day uses date only (YYYY-MM-DD)
      event.start = { date: startDate.slice(0, 10) };
      event.end = { date: endDate.slice(0, 10) };
    } else {
      event.start = { dateTime: startDate };
      event.end = { dateTime: endDate };
    }

    return this.makeRequest<any>(
      `${this.calendarBase}/calendars/primary/events`,
      {
        method: "POST",
        body: JSON.stringify(event),
      }
    );
  }

  async deleteCalendarEvent(eventId: string) {
    await this.makeRequest<void>(
      `${this.calendarBase}/calendars/primary/events/${encodeURIComponent(
        eventId
      )}`,
      { method: "DELETE" }
    );
  }

  async getCalendarEvent(eventId: string) {
    return this.makeRequest<any>(
      `${this.calendarBase}/calendars/primary/events/${encodeURIComponent(
        eventId
      )}`
    );
  }

  async updateCalendarEvent(
    eventId: string,
    subject?: string,
    startDate?: string,
    endDate?: string,
    _reminderMinutesBeforeStart?: number,
    body?: string,
    location?: string,
    isAllDay?: boolean,
    _categories?: string[],
    attendees?: string[]
  ) {
    const patch: any = {};
    if (subject !== undefined) patch.summary = subject;
    if (body !== undefined) patch.description = body;
    if (location !== undefined) patch.location = location;
    if (attendees !== undefined)
      patch.attendees = attendees.map((email) => ({ email }));
    if (startDate || endDate || isAllDay !== undefined) {
      if (isAllDay) {
        if (startDate) patch.start = { date: startDate.slice(0, 10) };
        if (endDate) patch.end = { date: endDate.slice(0, 10) };
      } else {
        if (startDate) patch.start = { dateTime: startDate };
        if (endDate) patch.end = { dateTime: endDate };
      }
    }

    return this.makeRequest<any>(
      `${this.calendarBase}/calendars/primary/events/${encodeURIComponent(
        eventId
      )}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    );
  }

  /* ------------------------- Gmail ------------------------ */
  // Build a Gmail search query from inputs
  private buildQuery(
    startDate: string,
    endDate: string,
    fromAddress?: string,
    toAddress?: string,
    freeText?: string
  ): string {
    const parts: string[] = [];
    // Gmail supports unix epoch seconds for after/before
    const startEpoch = Math.floor(new Date(startDate).getTime() / 1000);
    const endEpoch = Math.floor(new Date(endDate).getTime() / 1000);
    if (!Number.isNaN(startEpoch)) parts.push(`after:${startEpoch}`);
    if (!Number.isNaN(endEpoch)) parts.push(`before:${endEpoch}`);
    if (fromAddress) parts.push(`from:${fromAddress}`);
    if (toAddress) parts.push(`to:${toAddress}`);
    if (freeText) parts.push(freeText);
    return parts.join(" ").trim();
  }

  async searchEmails(
    folder: "inbox" | "sentitems" | "drafts" | "archive",
    startDate: string,
    endDate: string,
    fromAddress?: string,
    toAddress?: string,
    _conversationId?: string,
    query?: string
  ) {
    // Map Google folders to Gmail labels
    const labelMap: Record<string, string | undefined> = {
      inbox: "INBOX",
      sentitems: "SENT",
      drafts: "DRAFT",
      archive: undefined, // archive == not INBOX
    };
    const label = labelMap[folder.toLowerCase()];

    const q = this.buildQuery(
      startDate,
      endDate,
      fromAddress,
      toAddress,
      query
    );
    const url = new URL(`${this.gmailBase}/users/${this.userId}/messages`);
    if (q) url.searchParams.set("q", q);
    if (label) url.searchParams.set("labelIds", label);
    if (folder === "archive") {
      // archived -> exclude INBOX
      url.searchParams.set("q", `${q} -label:INBOX`.trim());
    }
    url.searchParams.set("maxResults", "50");

    const list = await this.makeRequest<{
      messages?: { id: string; threadId: string }[];
    }>(url.toString());
    const messages = list.messages ?? [];
    // Fetch full metadata for each message
    const results = await Promise.all(messages.map((m) => this.getEmail(m.id)));
    return results;
  }

  async getEmail(messageId: string) {
    const url = new URL(
      `${this.gmailBase}/users/${this.userId}/messages/${encodeURIComponent(
        messageId
      )}`
    );
    url.searchParams.set("format", "full");
    return this.makeRequest<any>(url.toString());
  }

  async markEmailAsRead(messageId: string) {
    const url = `${this.gmailBase}/users/${
      this.userId
    }/messages/${encodeURIComponent(messageId)}/modify`;
    await this.makeRequest<void>(url, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    });
  }

  async archiveEmail(messageId: string) {
    const url = `${this.gmailBase}/users/${
      this.userId
    }/messages/${encodeURIComponent(messageId)}/modify`;
    const res = await this.makeRequest<any>(url, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    });
    return res;
  }

  // Build a simple RFC 2822 plaintext email and return base64url-encoded string
  private buildRawEmail({
    subject,
    body,
    toRecipients,
    ccRecipients,
    bccRecipients,
    inReplyTo,
    references,
    threadId,
  }: {
    subject: string;
    body: string;
    toRecipients: string[];
    ccRecipients?: string[];
    bccRecipients?: string[];
    inReplyTo?: string;
    references?: string;
    threadId?: string;
  }) {
    const headers: string[] = [];
    headers.push(`To: ${toRecipients.join(", ")}`);
    if (ccRecipients && ccRecipients.length)
      headers.push(`Cc: ${ccRecipients.join(", ")}`);
    if (bccRecipients && bccRecipients.length)
      headers.push(`Bcc: ${bccRecipients.join(", ")}`);
    headers.push(`Subject: ${subject}`);
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 7bit");
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    // Gmail will set From based on the authenticated user
    const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
    // base64url
    const b64 = btoa(unescape(encodeURIComponent(mime)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { raw: b64, threadId };
  }

  async draftEmail(
    subject: string,
    body: string,
    toRecipients: string[],
    ccRecipients?: string[],
    bccRecipients?: string[]
  ) {
    const message = this.buildRawEmail({
      subject,
      body,
      toRecipients,
      ccRecipients,
      bccRecipients,
    });
    const url = `${this.gmailBase}/users/${this.userId}/drafts`;
    const created = await this.makeRequest<any>(url, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return created;
  }

  async createReplyDraft(
    originalEmailId: string,
    replyAll = false,
    body?: string
  ) {
    const original = await this.getEmail(originalEmailId);
    const headers = new Map<string, string>();
    for (const h of original.payload?.headers ?? []) {
      if (h.name && h.value) headers.set(h.name.toLowerCase(), h.value);
    }
    const toHeader = headers.get("from") || "";
    const ccHeader = replyAll ? headers.get("to") || "" : "";
    const ccList = ccHeader
      ? ccHeader.split(",").map((s) => s.trim())
      : undefined;
    const inReplyTo = headers.get("message-id");
    const references = headers.get("references") || inReplyTo;

    const msg = this.buildRawEmail({
      subject: `Re: ${headers.get("subject") || ""}`,
      body: body ?? "",
      toRecipients: toHeader ? [toHeader] : [],
      ccRecipients: ccList,
      inReplyTo: inReplyTo ?? undefined,
      references: references ?? undefined,
      threadId: original.threadId,
    });
    const url = `${this.gmailBase}/users/${this.userId}/drafts`;
    return this.makeRequest<any>(url, {
      method: "POST",
      body: JSON.stringify({ message: msg }),
    });
  }

  async updateEmailDraft(
    draftId: string,
    subject?: string,
    body?: string,
    toRecipients?: string[],
    ccRecipients?: string[],
    bccRecipients?: string[]
  ) {
    // Replace the draft's message with a rebuilt one
    const existing = await this.makeRequest<any>(
      `${this.gmailBase}/users/${this.userId}/drafts/${encodeURIComponent(
        draftId
      )}`
    );
    const headers = new Map<string, string>();
    for (const h of existing.message?.payload?.headers ?? []) {
      if (h.name && h.value) headers.set(h.name.toLowerCase(), h.value);
    }
    const subjectFinal = subject ?? headers.get("subject") ?? "";
    const toFinal =
      toRecipients ?? (headers.get("to") ? [headers.get("to") as string] : []);
    const ccFinal =
      ccRecipients ??
      (headers.get("cc") ? [headers.get("cc") as string] : undefined);
    const bccFinal =
      bccRecipients ??
      (headers.get("bcc") ? [headers.get("bcc") as string] : undefined);
    const bodyFinal = body ?? "";
    const msg = this.buildRawEmail({
      subject: subjectFinal,
      body: bodyFinal,
      toRecipients: toFinal,
      ccRecipients: ccFinal,
      bccRecipients: bccFinal,
      threadId: existing.message?.threadId,
    });

    const url = `${this.gmailBase}/users/${
      this.userId
    }/drafts/${encodeURIComponent(draftId)}`;
    return this.makeRequest<any>(url, {
      method: "PUT",
      body: JSON.stringify({ id: draftId, message: msg }),
    });
  }

  async sendEmail(draftId: string) {
    const url = `${this.gmailBase}/users/${this.userId}/drafts/send`;
    await this.makeRequest<void>(url, {
      method: "POST",
      body: JSON.stringify({ id: draftId }),
    });
  }

  async deleteEmail(messageId: string) {
    await this.makeRequest<void>(
      `${this.gmailBase}/users/${this.userId}/messages/${encodeURIComponent(
        messageId
      )}`,
      { method: "DELETE" }
    );
  }

  async startGmailWatch(serverName: string) {
    const topicName = `projects/${this.env.GOOGLE_PROJECT_NAME}/topics/gmail-inbox-${serverName}`;

    if (!this.env.GOOGLE_PROJECT_NAME)
      throw new Error("Missing GOOGLE_PROJECT_NAME env var");

    const url = `${this.gmailBase}/users/${this.userId}/watch`;
    const body = {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE" as const, // replaces deprecated labelFilterAction
    };
    const resp = await this.makeRequest<{
      historyId: string;
      expiration: string;
    }>(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const { historyId } = resp;
    // save cursor so we can resume from where we left off
    await putServerCursor(this.env, serverName, historyId);
  }

  async listInboxAddsSince(startHistoryId: string): Promise<{
    messageIds: string[];
    latestHistoryId: string;
    hasMore: boolean;
  }> {
    const pageLimit = 10;
    const base = new URL(`${this.gmailBase}/users/${this.userId}/history`);
    base.searchParams.set("startHistoryId", startHistoryId);
    base.searchParams.append("labelId", "INBOX");
    base.searchParams.append("historyTypes", "messageAdded");

    const messageIds: string[] = [];
    let latestHistoryId = startHistoryId;
    let pageToken: string | undefined;
    let pages = 0;

    while (true) {
      if (pages++ > pageLimit) {
        return { messageIds, latestHistoryId, hasMore: true };
      }

      const url = new URL(base.toString());
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const data = await this.makeRequest<any>(url.toString());

      for (const h of data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const id = added?.message?.id;
          if (id) {
            messageIds.push(id);
          }
        }
      }
      if (data.historyId) {
        latestHistoryId = data.historyId;
      }

      if (!data.nextPageToken) {
        break;
      }
      pageToken = data.nextPageToken;
    }

    return { messageIds, latestHistoryId, hasMore: false };
  }

  async commitHistory(serverName: string, historyId: string) {
    await putServerCursor(this.env, serverName, historyId);
  }
}
