"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
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

async function fetchXMessages(accessToken: string): Promise<InboxMessage[]> {
  try {
    const res = await fetch(
      "https://api.twitter.com/2/users/me/mentions?max_results=10&tweet.fields=created_at,text,author_id&user.fields=name,username",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.data) return [];

    const usersMap: Record<string, { name: string; username: string }> = {};
    if (data.includes?.users) {
      for (const u of data.includes.users) {
        usersMap[u.id] = { name: u.name, username: u.username };
      }
    }

    return data.data.map((tweet: any) => ({
      id: tweet.id,
      platform: "x",
      name: usersMap[tweet.author_id]?.name || "Unknown",
      handle: `@${usersMap[tweet.author_id]?.username || "unknown"}`,
      text: tweet.text,
      time: relativeTime(tweet.created_at),
      unread: true,
    }));
  } catch {
    return [];
  }
}

async function fetchInstagramMessages(
  accessToken: string
): Promise<InboxMessage[]> {
  try {
    const res = await fetch(
      `https://graph.instagram.com/v25.0/me/conversations?fields=messages{message,from,created_time}&access_token=${accessToken}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.data) return [];

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
    return messages;
  } catch {
    return [];
  }
}

export async function getInboxMessages(): Promise<InboxMessage[]> {
  const session = await getSessionUser();
  if (!session) return [];

  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, session.id));

  const allMessages: InboxMessage[] = [];

  for (const account of accounts) {
    if (!account.accessTokenEnc) continue;

    let accessToken: string;
    try {
      accessToken = decryptSecret(account.accessTokenEnc);
    } catch {
      continue;
    }

    if (account.platform === "x") {
      const msgs = await fetchXMessages(accessToken);
      allMessages.push(...msgs);
    } else if (account.platform === "instagram") {
      const msgs = await fetchInstagramMessages(accessToken);
      allMessages.push(...msgs);
    }
  }

  allMessages.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return 0;
  });

  return allMessages.slice(0, 20);
}

export async function sendReply(
  platform: string,
  messageId: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const session = await getSessionUser();
  if (!session) return { success: false, error: "Not signed in" };

  const account = await db
    .select()
    .from(socialAccounts)
    .where(
      eq(socialAccounts.userId, session.id)
    )
    .then((rows) => rows.find((r) => r.platform === platform));

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
    if (platform === "x") {
      const res = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          reply: { in_reply_to_tweet_id: messageId },
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
      error: `Reply not yet supported for ${platform}`,
    };
  } catch (e: any) {
    return { success: false, error: e.message || "Network error" };
  }
}

