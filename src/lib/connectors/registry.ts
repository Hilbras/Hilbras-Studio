/**
 * The connector registry — the one place the Runtime looks a platform up.
 *
 * ## Why this module exists
 *
 * The Runtime must never learn a platform's name from anywhere but a
 * `Connector`. It used to import `getConnector` from `legacy.ts`, which meant
 * the name "legacy adapter" was baked into the Runtime's dependency graph and
 * every future connector had somewhere else to be registered. This module is
 * that somewhere else: it is the seam, and `legacy.ts` is an implementation
 * detail behind it.
 *
 * ## What a connector is *not* responsible for
 *
 * Deciding whether an account may act. That is the account model's job
 * (`capabilitiesForAccount`), and it is narrower than anything here: a platform
 * that can publish may still be connected through an account that cannot. A
 * `Connector` answers "what can this platform do", never "may this account do
 * it" — conflating the two is how a disabled account ends up publishing.
 */

import {
  capabilitiesForPlatform,
  isPlatformId,
  PLATFORM_IDS,
  platformSupports,
  type CapabilityName,
} from "@/lib/platforms";

import { CONNECTORS, getConnector } from "./legacy";
import type { Connector } from "./types";

export { getConnector, CONNECTORS };

/** Every platform this build knows, connect-only ones included. */
export function knownPlatforms(): string[] {
  return [...PLATFORM_IDS];
}

/** The platforms that can actually dispatch something today. */
export function publishingPlatforms(): string[] {
  return PLATFORM_IDS.filter((id) => platformSupports(id, "publish_post"));
}

/**
 * What a platform can do, or nothing for an id this build does not know.
 *
 * Answers from the registry rather than from a connector instance, so it is
 * usable from the UI without constructing adapters or touching the server graph.
 */
export function platformCapabilities(
  platform: string,
): readonly CapabilityName[] {
  return capabilitiesForPlatform(platform);
}

/** Whether a platform can perform a capability. */
export function supportsCapability(
  platform: string,
  capability: CapabilityName,
): boolean {
  return platformSupports(platform, capability);
}

/**
 * A connector and the capability it was asked for, or a reason there is none.
 *
 * The Runtime needs the *reason* a capability is unavailable, not just a null,
 * because "LinkedIn cannot publish posts" and "there is no such platform" lead
 * the user somewhere completely different. The executor turns this into a
 * `ConnectorError` so the failure is recorded rather than thrown away.
 */
export type CapabilityLookup =
  | { ok: true; connector: Connector; capability: CapabilityName }
  | {
      ok: false;
      /** `unsupported` for a real platform lacking it, `not_connected` for a name we do not have. */
      code: "unsupported" | "not_connected";
      message: string;
    };

/**
 * Resolve a platform to a connector that can perform a capability.
 *
 * The single gate every capability call should pass through, so "can this
 * happen?" is answered in exactly one place and cannot drift per call site.
 */
export function lookupCapability(
  platform: string,
  capability: CapabilityName,
): CapabilityLookup {
  if (!isPlatformId(platform)) {
    return {
      ok: false,
      code: "not_connected",
      message: `"${platform}" is not a platform this build knows.`,
    };
  }

  if (!platformSupports(platform, capability)) {
    return {
      ok: false,
      code: "unsupported",
      message: `${platform} cannot ${capability.replace(/_/g, " ")}.`,
    };
  }

  const connector = getConnector(platform);
  if (!connector) {
    // The registry says it can and there is no adapter. That is a bug in the
    // build, not a user error, so it says so rather than blaming the account.
    return {
      ok: false,
      code: "not_connected",
      message: `${platform} declares "${capability}" but has no connector.`,
    };
  }

  return { ok: true, connector, capability };
}
