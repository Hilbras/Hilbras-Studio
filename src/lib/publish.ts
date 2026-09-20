"use server";

import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getSessionUser } from "@/lib/session";

interface PublishResult {
  platform: string;
  success: boolean;
  postId?: string;
  error?: string;
  url?: string;
}

/**
 * Get a decrypted access token for a specific connected platform.
 */
async function getAccessToken(userId: string, platform: string): Promise<string | null> {
  const [account] = await db
    .select({ accessTokenEnc: socialAccounts.accessTokenEnc })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.userId, userId),
        eq(socialAccounts.platform, platform)
      )
    )
    .limit(1);

  if (!account?.accessTokenEnc) return null;
  try {
    return decryptSecret(account.accessTokenEnc);
  } catch {
    return null;
  }
}

/**
 * Publish to Instagram via Graph API.
 * Instagram requires: create container → wait for processing → publish container.
 */
async function publishToInstagram(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const token = await getAccessToken(userId, "instagram");
  if (!token) {
    return { platform: "instagram", success: false, error: "Instagram not connected" };
  }

  try {
    // Step 1: Get the Instagram Business Account ID
    const meRes = await fetch(
      `https://graph.instagram.com/me?fields=id,account_type&access_token=${encodeURIComponent(token)}`
    );
    if (!meRes.ok) {
      return { platform: "instagram", success: false, error: `Failed to get Instagram account: ${meRes.status}` };
    }
    const me = await meRes.json() as { id: string; account_type: string };
    const igUserId = me.id;

    if (me.account_type === "NONE") {
      return { platform: "instagram", success: false, error: "Instagram requires a Business/Creator account" };
    }

    // Step 2: Create media container
    const containerParams: Record<string, string> = {
      access_token: token,
    };

    if (imageUrl) {
      // Photo post
      containerParams.media_type = "IMAGE";
      containerParams.image_url = imageUrl;
      containerParams.caption = text;
    } else {
      // Text-only post using media_type=TEXT (available for some accounts)
      // If text-only isn't supported, we'll use a fallback
      containerParams.media_type = "IMAGE";
      // For text-only we need an image URL; Instagram doesn't support pure text posts via API
      return { platform: "instagram", success: false, error: "Instagram requires an image. Please add an image URL." };
    }

    const containerUrl = new URL(`https://graph.facebook.com/v21.0/${igUserId}/media`);
    const containerRes = await fetch(containerUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(containerParams),
    });

    if (!containerRes.ok) {
      const err = await containerRes.json() as { error?: { message?: string } };
      return { platform: "instagram", success: false, error: err.error?.message || `Container creation failed: ${containerRes.status}` };
    }

    const container = await containerRes.json() as { id: string };
    const containerId = container.id;

    // Step 3: Wait briefly for container to be ready, then publish
    // In production you'd poll the container status, but for now we add a small delay
    await new Promise((r) => setTimeout(r, 2000));

    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: token,
          creation_id: containerId,
        }),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.json() as { error?: { message?: string } };
      return { platform: "instagram", success: false, error: err.error?.message || `Publish failed: ${publishRes.status}` };
    }

    const published = await publishRes.json() as { id: string };
    return {
      platform: "instagram",
      success: true,
      postId: published.id,
      url: `https://www.instagram.com/p/${published.id}`,
    };
  } catch (e: any) {
    return { platform: "instagram", success: false, error: e.message || "Instagram publish failed" };
  }
}

/**
 * Publish to Facebook Pages via Graph API.
 */
async function publishToFacebook(userId: string, text: string, imageUrl?: string): Promise<PublishResult> {
  const token = await getAccessToken(userId, "facebook");
  if (!token) return { platform: "facebook", success: false, error: "Facebook not connected" };

  try {
    // Get user's pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`
    );
    if (!pagesRes.ok) {
      return { platform: "facebook", success: false, error: `Failed to get pages: ${pagesRes.status}` };
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

    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!publishRes.ok) {
      const err = await publishRes.json() as { error?: { message?: string } };
      return { platform: "facebook", success: false, error: err.error?.message || `Publish failed: ${publishRes.status}` };
    }

    const published = await publishRes.json() as { id: string };
    return {
      platform: "facebook",
      success: true,
      postId: published.id,
      url: `https://www.facebook.com/posts/${published.id}`,
    };
  } catch (e: any) {
    return { platform: "facebook", success: false, error: e.message || "Facebook publish failed" };
  }
}

/**
 * Publish to X (Twitter) via API v2.
 * Note: X posting requires elevated access (Basic or Pro tier).
 */
async function publishToX(userId: string, text: string): Promise<PublishResult> {
  const token = await getAccessToken(userId, "x");
  if (!token) return { platform: "x", success: false, error: "X not connected" };

  try {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
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
      url: published.data?.id ? `https://x.com/i/web/status/${published.data.id}` : undefined,
    };
  } catch (e: any) {
    return { platform: "x", success: false, error: e.message || "X publish failed" };
  }
}

/**
 * Main publish function — routes to the right platform connector.
 */
export async function publishPost(
  platform: string,
  text: string,
  imageUrl?: string
): Promise<PublishResult> {
  const session = await getSessionUser();
  if (!session) return { platform, success: false, error: "Not signed in" };

  switch (platform) {
    case "instagram":
      return publishToInstagram(session.id, text, imageUrl);
    case "facebook":
      return publishToFacebook(session.id, text, imageUrl);
    case "x":
      return publishToX(session.id, text);
    default:
      return {
        platform,
        success: false,
        error: `Publishing not yet supported for ${platform}`,
      };
  }
}

/**
 * Publish to all connected platforms at once.
 */
export async function publishToAll(
  text: string,
  imageUrl?: string,
  platforms?: string[]
): Promise<PublishResult[]> {
  const session = await getSessionUser();
  if (!session) return [{ platform: "all", success: false, error: "Not signed in" }];

  const targetPlatforms = platforms ?? ["instagram", "facebook", "x"];
  const results = await Promise.all(
    targetPlatforms.map((p) => publishPost(p, text, imageUrl))
  );
  return results;
}