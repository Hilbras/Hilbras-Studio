import "server-only";

import { fetchWithTimeout } from "../http";
import { sanitizeResultUrl } from "../result-url";

import { connectionError, errorMessage, getConnectedAccount } from "./shared";
import type { PublishResult } from "./types";

/** One Bot API root — every call is `<root>/bot<token>/<method>`. */
const TELEGRAM_API = "https://api.telegram.org";

/** Shape of a Telegram Bot API answer. */
export type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; description: string };

/** The message Telegram posted — the fields the result link and split need. */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string };
}

/**
 * One Telegram Bot API call.
 *
 * Exported because the Accounts connect action validates the very same
 * endpoints (`getMe` / `getChat` / `getChatMember`) and must see Telegram's
 * own `description` to phrase a connect-specific error — callers map that raw
 * text themselves (`friendlyTelegramError` for publishing).
 */
export async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramApiResult<T>> {
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!body.ok || body.result === undefined || body.result === null) {
      return {
        ok: false,
        description: body.description || `Telegram returned HTTP ${res.status}`,
      };
    }
    return { ok: true, result: body.result };
  } catch (e) {
    return { ok: false, description: errorMessage(e, "Could not reach Telegram") };
  }
}


/** Telegram's raw failure, rephrased as something the user can act on. */
function friendlyTelegramError(description: string): string {
  if (/chat not found|wrong chat id/i.test(description)) {
    return "Chat not found — check the chat ID and that the bot is still a member of it.";
  }
  if (/not enough rights|have no rights|can'?t send (messages|photos|videos)/i.test(description)) {
    return "The bot does not have the right to post in that chat — make it an administrator with permission to post messages.";
  }
  if (/bot was kicked|bot is not a member|user is deactivated/i.test(description)) {
    return "The bot was removed from the chat — add it back and publish again.";
  }
  if (/peer_id_invalid/i.test(description)) {
    return "Telegram does not know that chat — send the bot a message first, or use the chat's @username.";
  }
  if (/wrong file identifier|failed to get/i.test(description)) {
    return "Telegram could not fetch the media — the URL must be publicly reachable.";
  }
  return `Telegram: ${description}`;
}

/**
 * Split long text into messages of at most 4096 characters, preferring newline
 * boundaries — a mid-word cut is how a scheduled post silently loses its shape.
 */
function splitTelegramMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Send `text` as one or more messages and return the last one posted. */
async function sendTelegramText(
  token: string,
  chatId: string,
  text: string
): Promise<TelegramApiResult<TelegramMessage>> {
  let last: TelegramMessage | null = null;
  for (const chunk of splitTelegramMessage(text)) {
    const sent = await telegramApi<TelegramMessage>(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
    if (!sent.ok) return sent;
    last = sent.result;
  }
  if (!last) return { ok: false, description: "Nothing to send" };
  return { ok: true, result: last };
}

/** Permalink for public chats — private chats and groups have no t.me link. */
function telegramPermalink(message: TelegramMessage): string | undefined {
  return message.chat.username
    ? sanitizeResultUrl(
        "telegram",
        `https://t.me/${message.chat.username}/${message.message_id}`
      )
    : undefined;
}

/**
 * Publish through the Telegram Bot API.
 *
 * The connection stores the bot token as `accessToken_enc` and the chat's
 * numeric id as `platform_account_id`; `tokenExpiresAt` stays null because bot
 * tokens do not expire (`effectiveTokenExpiry` leaves an unknown expiry null
 * for platforms outside its refresh list, so nothing ever tries to "refresh").
 *
 * Media captions cap at 1024 characters — longer text follows the media as its
 * own message instead of being truncated. Video URLs are detected by extension
 * and sent with `sendVideo`; everything else goes through `sendPhoto`.
 */
export async function publishToTelegram(
  userId: string,
  text: string,
  imageUrl?: string,
  accountKey?: string
): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "telegram", accountKey);
  if (!account.ok) {
    return {
      platform: "telegram",
      success: false,
      error: connectionError("telegram", account.problem),
    };
  }
  if (!text.trim() && !imageUrl) {
    return {
      platform: "telegram",
      success: false,
      error: "Nothing to publish — the post is empty.",
    };
  }

  const token = account.accessToken;
  const chatId = account.platformAccountId;
  const fail = (description: string): PublishResult => ({
    platform: "telegram",
    success: false,
    error: friendlyTelegramError(description),
  });

  if (imageUrl) {
    const isVideo = /\.(mp4|mov|webm|mkv|avi)(\?|#|$)/i.test(imageUrl);
    const mediaMethod = isVideo ? "sendVideo" : "sendPhoto";
    const mediaParam = isVideo ? "video" : "photo";

    if (text.length <= 1024) {
      const media = await telegramApi<TelegramMessage>(token, mediaMethod, {
        chat_id: chatId,
        [mediaParam]: imageUrl,
        ...(text ? { caption: text } : {}),
      });
      if (!media.ok) return fail(media.description);
      return {
        platform: "telegram",
        success: true,
        postId: String(media.result.message_id),
        url: telegramPermalink(media.result),
      };
    }

    // Over the caption limit: the media goes out first, the full text follows
    // as its own message — nothing is cut, and the pair reads naturally.
    const media = await telegramApi<TelegramMessage>(token, mediaMethod, {
      chat_id: chatId,
      [mediaParam]: imageUrl,
    });
    if (!media.ok) return fail(media.description);

    const followUp = await sendTelegramText(token, chatId, text);
    if (!followUp.ok) {
      return {
        platform: "telegram",
        success: false,
        error: `Posted the media, but the text follow-up failed: ${friendlyTelegramError(followUp.description)}`,
      };
    }
    return {
      platform: "telegram",
      success: true,
      postId: String(media.result.message_id),
      url: telegramPermalink(media.result),
    };
  }

  const sent = await sendTelegramText(token, chatId, text);
  if (!sent.ok) return fail(sent.description);
  return {
    platform: "telegram",
    success: true,
    postId: String(sent.result.message_id),
    url: telegramPermalink(sent.result),
  };
}
