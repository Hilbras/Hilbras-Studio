import { describe, expect, it } from "vitest";

import {
  PLATFORM_IDS,
  PLATFORM_REGISTRY,
  PUBLISHING_CAPABILITIES,
  allPlatforms,
  getPublishingCapability,
  isPublishablePlatform,
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
    expect(getPublishingCapability("linkedin")?.status).toBe("connect_only");
    expect(getPublishingCapability("not-a-platform")).toBeNull();
  });
});
