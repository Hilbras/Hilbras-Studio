import { describe, expect, it } from "vitest";

import {
  buildComposeUserPrompt,
  buildLengthRetryPrompt,
  cleanPostText,
  composePost,
} from "./compose";
import type { Completer } from "./planner";

/** A model that returns each reply in turn. */
function scripted(...replies: string[]): Completer & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const complete = async (_system: string, user: string) => {
    calls.push(user);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply;
  };
  return Object.assign(complete, { calls });
}

const long = (n: number) => "x".repeat(n);

describe("cleanPostText", () => {
  it("leaves a plain post alone", () => {
    expect(cleanPostText("  A real post.  ")).toBe("A real post.");
  });

  it("strips a code fence", () => {
    expect(cleanPostText("```\nA post.\n```")).toBe("A post.");
    expect(cleanPostText("```text\nA post.\n```")).toBe("A post.");
  });

  it("strips one matching pair of surrounding quotes", () => {
    expect(cleanPostText('"A post."')).toBe("A post.");
    expect(cleanPostText("'A post.'")).toBe("A post.");
    expect(cleanPostText("“A post.”")).toBe("A post.");
  });

  it("strips a single leading label", () => {
    expect(cleanPostText("Post: A post.")).toBe("A post.");
    expect(cleanPostText("Caption: A post.")).toBe("A post.");
  });

  it("does not strip a label that appears in the post itself", () => {
    // A caption that legitimately opens with "Post:" must survive. Guessing
    // here produces plausible text the user never wrote, published under their
    // name.
    expect(cleanPostText("Post:-mortem on shipping weekly")).toBe(
      "-mortem on shipping weekly",
    );
    expect(cleanPostText("I read a post: it was about cadence")).toBe(
      "I read a post: it was about cadence",
    );
  });

  it("keeps internal quotes and punctuation", () => {
    expect(cleanPostText('He said "ship it". So we did.')).toBe(
      'He said "ship it". So we did.',
    );
  });

  it("returns nothing for nothing", () => {
    expect(cleanPostText("   ")).toBe("");
    expect(cleanPostText('" "')).toBe('" "');
  });

  it("keeps multi-paragraph text intact", () => {
    const post = "Line one.\n\nLine two.";
    expect(cleanPostText(post)).toBe(post);
  });
});

describe("the compose prompt", () => {
  it("states the brief, the tone, and the platform's hard limit", () => {
    const prompt = buildComposeUserPrompt({
      brief: "one reason weekly beats monthly",
      tone: "direct",
      platform: "x",
    });
    expect(prompt).toContain("one reason weekly beats monthly");
    expect(prompt).toContain("direct");
    expect(prompt).toContain("Hard limit: 280 characters.");
  });

  it("omits the limit for a platform that states none", () => {
    const prompt = buildComposeUserPrompt({ brief: "x", platform: "myspace" });
    expect(prompt).not.toContain("Hard limit");
  });

  it("names the number that failed when re-asking", () => {
    const prompt = buildLengthRetryPrompt(
      { brief: "one reason", platform: "x" },
      412,
    );
    expect(prompt).toContain("It was 412 characters.");
    expect(prompt).toContain("The limit is 280 characters.");
    expect(prompt).toContain("Cut whole clauses, not words");
  });
});

describe("composePost", () => {
  it("returns the model's text when it fits", async () => {
    const complete = scripted("A post that fits.");
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      complete,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe("A post that fits.");
    expect(result.ok && result.retried).toBe(false);
    expect(complete.calls).toHaveLength(1);
  });

  it("cleans the model's wrappers before measuring", async () => {
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      scripted('"A post that fits."'),
    );
    expect(result.ok && result.text).toBe("A post that fits.");
  });

  it("asks again once when the answer is over the limit", async () => {
    const complete = scripted(long(400), "Short enough.");
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      complete,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toBe("Short enough.");
    expect(result.ok && result.retried).toBe(true);
    expect(complete.calls).toHaveLength(2);
    expect(complete.calls[1]).toContain("It was 400 characters.");
  });

  it("fails rather than publishing a post cut short", async () => {
    // Truncated is a post that ends mid-sentence, and a user cannot tell that
    // from a post the model wrote badly.
    const complete = scripted(long(400), long(390));
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      complete,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_content");
    expect(!result.ok && result.error.retryable).toBe(false);
    // The length reported is the one that was actually rejected, not the first
    // attempt's — the message is what a user reads to understand the failure.
    expect(!result.ok && result.error.message).toContain("390");
    expect(!result.ok && result.error.message).toContain("280");
  });

  it("measures against the limit of the platform it was given", async () => {
    const result = await composePost(
      { brief: "an angle", platform: "instagram" },
      scripted(long(400)),
    );
    // 400 characters is far over X's 280 and well inside Instagram's 2200.
    expect(result.ok).toBe(true);
  });

  it("has no limit to fit when there is no platform", async () => {
    const result = await composePost({ brief: "an angle" }, scripted(long(400)));
    expect(result.ok).toBe(true);
  });

  it("fails on an answer that cleans down to nothing", async () => {
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      scripted("   "),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("invalid_content");
  });

  it("makes only one call when the limit is not given as an option", async () => {
    const complete = scripted(long(400));
    const result = await composePost(
      { brief: "an angle", platform: "x" },
      complete,
      { maxAttempts: 1 },
    );
    expect(result.ok).toBe(false);
    expect(complete.calls).toHaveLength(1);
  });

  it("lets a transport failure propagate for the caller to classify", async () => {
    // A provider outage is not a content problem, and the caller is the only
    // place that knows what a failure like this is worth.
    const complete: Completer = async () => {
      throw new Error("503");
    };
    await expect(
      composePost({ brief: "an angle", platform: "x" }, complete),
    ).rejects.toThrow("503");
  });
});
