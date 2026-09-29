import "server-only";

import { fetchWithTimeout } from "../http";
import { sanitizeResultUrl } from "../result-url";

import { connectionError, errorMessage, getConnectedAccount } from "./shared";
import type { PublishResult } from "./types";

/**
 * Publish to X (Twitter) via API v2.
 * Note: X posting requires elevated access (Basic or Pro tier).
 */
export async function publishToX(userId: string, text: string, accountKey?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "x", accountKey);
  if (!account.ok) {
    return { platform: "x", success: false, error: connectionError("x", account.problem) };
  }

  try {
    const res = await fetchWithTimeout("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const err = await res.json() as { errors?: Array<{ message: string }> };
      return { platform: "x", success: false, error: err.errors?.[0]?.message || `X publish failed: ${res.status}` };
    }

    const published = await res.json() as { data?: { id: string } };
    return {
      platform: "x",
      success: true,
      postId: published.data?.id,
      url: published.data?.id
        ? sanitizeResultUrl("x", `https://x.com/i/web/status/${published.data.id}`)
        : undefined,
    };
  } catch (e) {
    return { platform: "x", success: false, error: errorMessage(e, "X publish failed") };
  }
}
