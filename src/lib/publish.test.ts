import { describe, expect, it } from "vitest";

import { publishToAllForUser, type PublishResult } from "./publish";

describe("publishToAllForUser", () => {
  it("settles every platform independently when one connector rejects", async () => {
    const publish = async (
      _userId: string,
      platform: string,
    ): Promise<PublishResult> => {
      if (platform === "x") throw new Error("platform unavailable");
      if (platform === "threads") {
        return { platform, success: false, error: "not connected" };
      }
      return { platform, success: true, postId: `${platform}-1` };
    };

    const results = await publishToAllForUser(
      "user-1",
      "hello",
      undefined,
      ["instagram", "x", "threads"],
      publish,
    );

    expect(results).toEqual([
      { platform: "instagram", success: true, postId: "instagram-1" },
      { platform: "x", success: false, error: "platform unavailable" },
      { platform: "threads", success: false, error: "not connected" },
    ]);
  });

  it("keeps a successful result when another target throws", async () => {
    const publish = async (
      _userId: string,
      platform: string,
    ): Promise<PublishResult> => {
      if (platform === "x") throw new Error("timeout");
      return { platform, success: true };
    };

    await expect(
      publishToAllForUser(
        "user-1",
        "hello",
        undefined,
        ["x", "facebook"],
        publish,
      ),
    ).resolves.toEqual([
      { platform: "x", success: false, error: "timeout" },
      { platform: "facebook", success: true },
    ]);
  });
});
