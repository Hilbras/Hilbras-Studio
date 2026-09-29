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

  it("maps a provider timeout to a failed result, not a thrown error", async () => {
    const publish = async (): Promise<PublishResult> => {
      throw new Error("Request timed out after 60000 ms");
    };

    await expect(
      publishToAllForUser("user-1", "hello", undefined, ["x", "threads"], publish),
    ).resolves.toEqual([
      { platform: "x", success: false, error: "Request timed out after 60000 ms" },
      { platform: "threads", success: false, error: "Request timed out after 60000 ms" },
    ]);
  });

  it("reports every platform as failed when all connectors reject", async () => {
    const publish = async (): Promise<PublishResult> => {
      throw new Error("network unreachable");
    };

    const results = await publishToAllForUser(
      "user-1",
      "hello",
      undefined,
      ["instagram", "facebook"],
      publish,
    );

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.error).toBe("network unreachable");
    }
  });

  it("validates connector-produced URLs and text before they are returned", async () => {
    const publish = async (
      _userId: string,
      platform: string,
    ): Promise<PublishResult> => ({
      platform,
      success: true,
      postId: "  ".repeat(3),
      url: "http://169.254.169.254/latest/meta-data",
      error: "y".repeat(5000),
    });

    const results = await publishToAllForUser(
      "user-1",
      "hello",
      undefined,
      ["instagram"],
      publish,
    );

    expect(results[0]).toEqual({
      platform: "instagram",
      success: true,
      error: "y".repeat(2000),
    });
    expect(results[0].url).toBeUndefined();
    expect(results[0].postId).toBeUndefined();
  });
});
