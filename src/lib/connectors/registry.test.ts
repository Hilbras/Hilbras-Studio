import { describe, expect, it } from "vitest";

import { PLATFORM_IDS, platformSupports } from "@/lib/platforms";

import {
  getConnector,
  knownPlatforms,
  lookupCapability,
  platformCapabilities,
  publishingPlatforms,
  supportsCapability,
} from "./registry";

/**
 * The registry is the single gate every capability call passes through, so these
 * tests are mostly about one thing: the two places that know what a platform can
 * do must not disagree.
 *
 * `PUBLISHING_CAPABILITIES` (the registry) and `Connector.capabilities` (the
 * adapter) are separate declarations that have to stay in step. When they drift,
 * a plan can validate against one and execute against the other — the goal looks
 * runnable, and the step fails halfway through with a message that names neither
 * as the cause. v0.5.1 derives the adapter's set from the registry to remove the
 * possibility; these tests hold that line.
 */
describe("connector registry", () => {
  it("resolves a platform that can do the thing", () => {
    const found = lookupCapability("x", "publish_post");

    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.connector.platform).toBe("x");
      expect(found.capability).toBe("publish_post");
    }
  });

  it("refuses a real platform that lacks the capability, and says which it is", () => {
    const missing = lookupCapability("linkedin", "publish_post");

    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      // `unsupported`, not `not_connected`: the user *is* connected to LinkedIn,
      // and telling them otherwise sends them to fix the wrong thing.
      expect(missing.code).toBe("unsupported");
      expect(missing.message).toContain("linkedin");
    }
  });

  it("distinguishes a platform name this build does not know", () => {
    const unknown = lookupCapability("myspace", "publish_post");

    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("not_connected");
    }
  });

  it("refuses a capability no platform implements today", () => {
    // Declared in the vocabulary, implemented by nobody. A step naming it must
    // fail at the gate rather than reaching a connector that cannot help.
    for (const id of PLATFORM_IDS) {
      expect(lookupCapability(id, "get_posts").ok).toBe(false);
      expect(lookupCapability(id, "delete_post").ok).toBe(false);
    }
  });

  it("keeps the registry and every adapter's declared capabilities in agreement", () => {
    for (const platform of knownPlatforms()) {
      const declared = platformCapabilities(platform);
      const connector = getConnector(platform);

      expect(connector, `${platform} has no adapter`).not.toBeNull();
      expect(connector?.capabilities, `${platform} drifted from the registry`).toEqual(
        declared,
      );
    }
  });

  it("gives a connector to every platform that declares a capability", () => {
    // The "declares but has no adapter" branch is a build bug, not a user
    // error, and must be reported as such rather than as a missing connection.
    for (const platform of knownPlatforms()) {
      if (!platformCapabilities(platform).length) continue;

      const found = lookupCapability(platform, "publish_post");
      expect(
        found.ok,
        `${platform} declares capabilities but has no connector`,
      ).toBe(true);
    }
  });

  it("reports no capabilities for a platform it does not know", () => {
    expect(platformCapabilities("myspace")).toEqual([]);
    expect(supportsCapability("myspace", "publish_post")).toBe(false);
  });

  it("lists exactly the platforms that can publish", () => {
    const listed = publishingPlatforms();

    expect(listed.length).toBeGreaterThan(0);
    for (const platform of listed) {
      expect(platformSupports(platform, "publish_post")).toBe(true);
    }
    // And nothing that cannot is left off the list by accident.
    for (const platform of knownPlatforms()) {
      expect(listed.includes(platform)).toBe(
        platformSupports(platform, "publish_post"),
      );
    }
  });

  it("includes connect-only platforms in the known set", () => {
    // A Goal targeting LinkedIn must be refused as *unsupported at planning
    // time*, which requires LinkedIn to be present with an empty set rather than
    // absent.
    expect(knownPlatforms()).toContain("linkedin");
    expect(publishingPlatforms()).not.toContain("linkedin");
  });
});
