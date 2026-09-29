import "server-only";

import { fetchWithTimeout } from "../http";
import { sanitizeResultUrl } from "../result-url";
import type { GraphError } from "./shared";

import {
  connectionError,
  errorMessage,
  getConnectedAccount,
  graphErrorMessage,
  GRAPH_FACEBOOK,
} from "./shared";
import type { PublishResult } from "./types";

/**
 * Publish to Facebook Pages via Graph API.
 */
export async function publishToFacebook(userId: string, text: string, imageUrl?: string, accountKey?: string): Promise<PublishResult> {
  const account = await getConnectedAccount(userId, "facebook", accountKey);
  if (!account.ok) {
    return { platform: "facebook", success: false, error: connectionError("facebook", account.problem) };
  }
  const token = account.accessToken;

  try {
    // Get user's pages
    const pagesRes = await fetchWithTimeout(
      `${GRAPH_FACEBOOK}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`
    );
    if (!pagesRes.ok) {
      const err = (await pagesRes.json().catch(() => ({}))) as GraphError;
      return {
        platform: "facebook",
        success: false,
        error: graphErrorMessage("facebook", err, `Failed to get pages: ${pagesRes.status}`),
      };
    }
    const pages = await pagesRes.json() as { data: Array<{ id: string; name: string; access_token: string }> };

    if (!pages.data?.length) {
      return { platform: "facebook", success: false, error: "No Facebook Pages found" };
    }

    // Publish to the first page
    const page = pages.data[0];
    const body: Record<string, string> = {
      message: text,
      access_token: page.access_token,
    };

    if (imageUrl) {
      body.url = imageUrl;
    }

    const publishRes = await fetchWithTimeout(
      `${GRAPH_FACEBOOK}/${page.id}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.json() as GraphError;
      return {
        platform: "facebook",
        success: false,
        error: graphErrorMessage("facebook", err, `Publish failed: ${publishRes.status}`),
      };
    }

    const published = await publishRes.json() as { id: string };
    return {
      platform: "facebook",
      success: true,
      postId: published.id,
      url: sanitizeResultUrl("facebook", `https://www.facebook.com/posts/${published.id}`),
    };
  } catch (e) {
    return { platform: "facebook", success: false, error: errorMessage(e, "Facebook publish failed") };
  }
}
