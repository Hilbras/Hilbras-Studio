import { describe, expect, it } from "vitest";

import {
  PLATFORM_IDS,
  PLATFORM_REGISTRY,
  PUBLISHING_CAPABILITIES,
  allPlatforms,
  capabilitiesForPlatform,
  getPublishingCapability,
  isPublishablePlatform,
  platformSupports,
} from "./platforms";

describe("platform registry invariants", () => {
  it("keeps registry order and ids unique", () => {
    const ids = allPlatforms().map((platform) => platform.id);

    expect(ids).toEqual([...PLATFORM_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has auth metadata for OAuth platforms and none for manual platforms", () => {
    for (const platform of allPlatforms()) {
      if (platform.connection === "manual") {
        expect(platform.auth).toBeUndefined();
      } else {
        expect(platform.auth).toBeDefined();
        expect(platform.auth?.clientIdEnv).toBeTruthy();
        expect(platform.auth?.clientSecretEnv).toBeTruthy();
      }
    }
  });

  it("keeps every registry entry addressable by its declared id", () => {
    for (const id of PLATFORM_IDS) {
      expect(PLATFORM_REGISTRY[id].id).toBe(id);
      expect(PUBLISHING_CAPABILITIES[id]).toBeDefined();
    }
  });

  it("separates connection support from current publishing support", () => {
    expect(isPublishablePlatform("instagram")).toBe(true);
    expect(isPublishablePlatform("telegram")).toBe(true);
    expect(isPublishablePlatform("linkedin")).toBe(false);
    expect(capabilitiesForPlatform("linkedin")).toEqual([]);
    expect(getPublishingCapability("not-a-platform")).toBeNull();
  });

  it("reports capabilities per platform rather than a publish/not-publish flag", () => {
    // The five working publishers share one set today.
    for (const id of ["instagram", "facebook", "threads", "x", "telegram"] as const) {
      expect(capabilitiesForPlatform(id)).toEqual([
        "create_post",
        "publish_post",
        "get_account",
      ]);
    }

    // A platform with no publisher is connectable and visibly incapable, which
    // `status: "connect_only"` could not distinguish from a publisher that had
    // simply not been written yet.
    expect(capabilitiesForPlatform("linkedin")).toEqual([]);
    expect(getPublishingCapability("linkedin")?.accountSelection).toBe("none");
  });

  it("answers capability questions for unknown platforms without throwing", () => {
    expect(capabilitiesForPlatform("not-a-platform")).toEqual([]);
    expect(platformSupports("not-a-platform", "publish_post")).toBe(false);
    expect(platformSupports("x", "get_posts")).toBe(false);
    expect(platformSupports("x", "publish_post")).toBe(true);
  });
});
