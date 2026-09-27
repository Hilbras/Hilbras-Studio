/**
 * Post creation — the one write path for a new post.
 *
 * Exists because ADR-004 keeps orchestration out of server actions: creating a
 * post is two inserts that must land together, and an action that performed
 * both would be holding a business rule in the browser-callable layer.
 *
 * The transaction is the whole point. A post whose targets failed to write is
 * schedulable, looks fine in the Composer's list, and then fails at publish
 * time with "Post has no target platforms" — a failure the user sees hours
 * after the thing they actually did wrong.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { posts } from "@/db/schema";

import { setPostTargets } from "./targets";

export interface NewPost {
  userId: string;
  content: string;
  platforms: readonly string[];
  imageUrl?: string | null;
  /** Present means the post is scheduled rather than a draft. */
  scheduledAt?: Date | null;
}

/** Create a post and its targets atomically. Returns the new post's id. */
export async function createPost(input: NewPost): Promise<string> {
  const postId = randomUUID();
  const scheduledAt = input.scheduledAt ?? null;

  return db.transaction(async (tx) => {
    await tx.insert(posts).values({
      id: postId,
      userId: input.userId,
      content: input.content,
      imageUrl: input.imageUrl || null,
      status: scheduledAt ? "scheduled" : "draft",
      scheduledAt,
    });

    await setPostTargets(tx, postId, input.platforms);

    return postId;
  });
}
