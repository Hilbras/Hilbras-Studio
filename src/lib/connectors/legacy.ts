import "server-only";

/**
 * The legacy adapter: presents today's five publishers through the Connector
 * interface.
 *
 * This is the whole point of ADR-002. The Runtime is written against
 * `Connector`, and the five working publishers are brought under that interface
 * here without changing a single line of their behaviour. Phase 3 replaces the
 * bodies of these adapters with real connectors and deletes this file's
 * string-based error classification — but the *interface* the Runtime depends on
 * does not change, which is what makes Phase 3 additive instead of a rewrite.
 *
 * @see ../connectors/types.ts for the contract and its rules.
 */

import {
  getPublishingCapability,
  isPlatformId,
  PLATFORM_IDS,
} from "@/lib/platforms";
import { publishForUser, type PublishResult } from "@/lib/publish";

import { classifyLegacyError, unknownError } from "./errors";
import type {
  CapabilityName,
  Connector,
  ConnectorContext,
  PublishPostInput,
  PublishPostResult,
} from "./types";

/** Translate one `PublishResult` into the connector's discriminated result. */
function toPublishResult(
  platform: string,
  result: PublishResult,
): PublishPostResult {
  if (result.success) {
    return {
      ok: true,
      platformPostId: result.postId,
      permalink: result.url,
    };
  }

  return {
    ok: false,
    error: classifyLegacyError(platform, result.error ?? "Publish failed"),
  };
}

function publishPost(
  platform: string,
  context: ConnectorContext,
  input: PublishPostInput,
): Promise<PublishPostResult> {
  // `idempotencyKey` is accepted and ignored: the legacy publishers predate
  // ADR-005 and have no result cache to consult. Swallowing it here — rather
  // than rejecting it — is what lets the interface ship the field now and have
  // connectors honour it individually as they are upgraded.
  void input.idempotencyKey;

  return publishForUser(
    context.userId,
    platform,
    input.text,
    input.mediaUrl,
  ).then(
    (result) => toPublishResult(platform, result),
    (cause: unknown) => ({ ok: false, error: unknownError(platform, cause) }),
  );
}

/** The five platforms that dispatch today, in registry order. */
const PUBLISHING_PLATFORMS = PLATFORM_IDS.filter(
  (id) => getPublishingCapability(id)?.status === "supported",
);

/**
 * Capabilities derived from the platform registry rather than restated here.
 *
 * `PUBLISHING_CAPABILITIES` is already the single source of truth for "can this
 * platform publish at all" — that is what the v0.1.0 remediation built it for.
 * Re-deriving it would create a second registry that can drift from the first.
 */
function capabilitiesFor(platform: string): readonly CapabilityName[] {
  const spec = getPublishingCapability(platform);
  if (spec?.status !== "supported") return [];
  return ["create_post", "publish_post", "get_account"];
}

function legacyConnector(platform: string): Connector {
  return {
    platform: platform as Connector["platform"],
    capabilities: capabilitiesFor(platform),
    publishPost: (context, input) => publishPost(platform, context, input),
  };
}

/**
 * Every known platform, including the connect-only ones.
 *
 * Connect-only platforms are present with an empty capability set rather than
 * absent. A Goal that targets one can then be validated as *unsupported at
 * planning time* — a clear message to the user — instead of failing halfway
 * through execution when the step finally runs.
 */
export const CONNECTORS: Readonly<Record<string, Connector>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_IDS.map((platform) => [platform, legacyConnector(platform)]),
  ),
);

/** The platforms a Run may actually dispatch to today. */
export function publishingConnectorIds(): string[] {
  return [...PUBLISHING_PLATFORMS];
}

/** Look up a connector, or `null` for an unknown platform id. */
export function getConnector(platform: string): Connector | null {
  if (!isPlatformId(platform)) return null;
  return CONNECTORS[platform] ?? null;
}
