"use server";

import { z } from "zod";
import { listGrants } from "@/lib/accounts/store";
import { getSessionUser } from "@/lib/session";
import { fetchWithTimeout } from "@/lib/http";
import { decryptSecret } from "@/lib/crypto";

export interface InboxMessage {
  id: string;
  platform: string;
  name: string;
  handle: string;
  text: string;
  time: string;
  unread: boolean;
}

/**
 * A provider fetch that failed, named so the UI can say "X is erroring"
 * instead of showing an empty inbox that reads as "nothing new"
 * (remediation Task 14: provider errors are distinct from an empty inbox).
 */
export interface InboxPlatformError {
  platform: string;
  error: string;
}

/** Best-effort human message from a provider error body. */
async function providerErrorText(
  res: Response,
  fallback: string
): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: unknown;
      title?: unknown;
      error?: { message?: unknown };
    };
    const detail =
      body.detail ?? body.error?.message ?? body.title ?? fallback;
    return typeof detail === "string" ? detail : fallback;
  } catch {
    return fallback;
  }
}

const replyInput = z.object({
  platform: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid message"),
  text: z.string().trim().min(1, "Reply cannot be empty").max(1000),
});

/** One mention as the X API returns it — optional fields stay optional. */
interface RawTweet {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d`;
}

async function fetchXMessages(
  accessToken: string
): Promise<{ messages: InboxMessage[]; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      "https://api.twitter.com/2/users/me/mentions?max_results=10&tweet.fields=created_at,text,author_id&user.fields=name,username",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      return { messages: [], error: await providerErrorText(res, `X request failed (${res.status})`) };
    }
    const data = await res.json();
    if (!data.data) return { messages: [] };

    const usersMap: Record<string, { name: string; username: string }> = {};
    if (data.includes?.users) {
      for (const u of data.includes.users) {
        usersMap[u.id] = { name: u.name, username: u.username };
      }
    }

    return data.data.map((tweet: RawTweet) => ({
      id: tweet.id ?? "",
      platform: "x",
      name: usersMap[tweet.author_id ?? ""]?.name || "Unknown",
      handle: `@${usersMap[tweet.author_id ?? ""]?.username || "unknown"}`,
      text: tweet.text ?? "",
      time: relativeTime(tweet.created_at ?? new Date(0).toISOString()),
      unread: true,
    }));
  } catch {
    return { messages: [], error: "Could not reach X — the request timed out or failed." };
  }
}

async function fetchInstagramMessages(
  accessToken: string
): Promise<{ messages: InboxMessage[]; error?: string }> {
  try {
    // Built with `URLSearchParams` rather than by interpolating the token into a
    // template. Instagram access tokens routinely contain `&`, `=`, `+` and `/`,
    // and an unencoded one silently truncates the request at the first `&` — a
    // message list that comes back empty with a 200, which reads as "no new
    // messages" rather than as a bug. It also keeps the token out of the request
    // line, where it would otherwise be the most obvious thing in any proxy log.
    const url = new URL("https://graph.instagram.com/v25.0/me/conversations");
    url.searchParams.set("fields", "messages{message,from,created_time}");
    url.searchParams.set("access_token", accessToken);

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return {
        messages: [],
        error: await providerErrorText(res, `Instagram request failed (${res.status})`),
      };
    }
    const data = await res.json();
    if (!data.data) return { messages: [] };

    const messages: InboxMessage[] = [];
    for (const conv of data.data.slice(0, 10)) {
      if (!conv.messages?.data) continue;
      for (const msg of conv.messages.data.slice(0, 1)) {
        messages.push({
          id: msg.id || conv.id,
          platform: "instagram",
          name: msg.from?.name || "Unknown",
          handle: msg.from?.username || "@unknown",
          text: msg.message,
          time: relativeTime(msg.created_time),
          unread: true,
        });
      }
    }
    return { messages };
  } catch {
    return {
      messages: [],
      error: "Could not reach Instagram — the request timed out or failed.",
    };
  }
}

export async function getInboxMessages(): Promise<{
  messages: InboxMessage[];
  errors: InboxPlatformError[];
}> {
  const session = await getSessionUser();
  if (!session) return { messages: [], errors: [] };

  // Grants, not connections: the inbox needs a token, and several accounts can
  // share one grant. Deduplicated because a grant behind three accounts would
  // otherwise be fetched three times.
  const seen = new Set<string>();
  const accounts = (await listGrants(session.id)).filter((g) => {
    if (seen.has(g.connectionId)) return false;
    seen.add(g.connectionId);
    return true;
  });

  const allMessages: InboxMessage[] = [];
  const errors: InboxPlatformError[] = [];

  for (const account of accounts) {
    if (!account.accessTokenEnc) continue;

    let accessToken: string;
    try {
      accessToken = decryptSecret(account.accessTokenEnc);
    } catch {
      continue;
    }

    if (account.platform === "x") {
      const { messages, error } = await fetchXMessages(accessToken);
      allMessages.push(...messages);
      if (error) errors.push({ platform: "x", error });
    } else if (account.platform === "instagram") {
      const { messages, error } = await fetchInstagramMessages(accessToken);
      allMessages.push(...messages);
      if (error) errors.push({ platform: "instagram", error });
    }
  }

  allMessages.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return 0;
  });

  return { messages: allMessages.slice(0, 20), errors };
}

export async function sendReply(
  platform: string,
  messageId: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };

  const parsed = replyInput.safeParse({ platform, messageId, text });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const account = (await listGrants(session.id)).find(
    (g) => g.platform === parsed.data.platform,
  );

  if (!account?.accessTokenEnc) {
    return { success: false, error: "Platform not connected" };
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(account.accessTokenEnc);
  } catch {
    return { success: false, error: "Token decryption failed" };
  }

  try {
    if (parsed.data.platform === "x") {
      const res = await fetchWithTimeout("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: parsed.data.text,
          reply: { in_reply_to_tweet_id: parsed.data.messageId },
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        return { success: false, error: err.detail || "Failed to send" };
      }
      return { success: true };
    }

    return {
      success: false,
      error: `Reply not yet supported for ${parsed.data.platform}`,
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

