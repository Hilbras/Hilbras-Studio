# Connectors

The contract between the Runtime and a platform. Introduced in **Phase 1**
(ADR-002) and standardised in Phase 3.

**Source of truth:** [`src/lib/connectors/types.ts`](../src/lib/connectors/types.ts).
This document explains the rules; the types are the contract.

---

## Why the interface comes first

The Runtime is written against `Connector`, never against a platform. Defining
the interface in Phase 1 — before the Runtime exists, and wrapping the five
working publishers in it immediately — means Phase 3 is additive: it fills in
capabilities and real error types, and the Runtime never changes.

If the interface arrived in Phase 3 instead, the Runtime's execution layer would
be built against an ad-hoc seam and then rewritten. That rewrite is the single
most expensive mistake available in this roadmap, and it is avoided by ordering.

---

## The rules

### 1. Nothing platform-specific may appear in the types

No Facebook Graph error codes. No Instagram container states. No Telegram chat
ids. A connector translates the platform's vocabulary into `CapabilityName` and
`ConnectorErrorCode` on the way in, and back on the way out.

This is the rule that makes the boundary real. The moment a `graph.instagram.com`
field appears in a `PublishPostResult`, the Runtime depends on Instagram.

### 2. Capabilities are per-account, not per-platform

`Connector.capabilities` says what a platform can do *in general*. The effective
set for a particular account is narrower — a Facebook Page and a Facebook
profile are different account types. Goals target **accounts** (Phase 2), and
capabilities are resolved per account so a disabled account cannot silently
vanish from a plan.

Connect-only platforms are registered with an **empty** capability set rather
than omitted. A Goal targeting one can then be rejected at planning time with a
clear message, instead of failing halfway through execution.

### 3. Errors are typed, and the Runtime never matches on strings

```ts
type ConnectorErrorCode =
  | "not_connected"      // no grant — user must connect
  | "expired"            // grant exists, session died — reconnect
  | "target_unavailable" // grant fine, the account behind it is gone
  | "forbidden"          // authenticated but not permitted
  | "rate_limited"       // transient
  | "invalid_content"    // the platform rejected the content
  | "unsupported"        // no publisher exists
  | "platform_error"     // the platform failed
  | "unknown";           // unclassified
```

`retryable` is set deliberately and is the *only* field the Runtime reads when
deciding whether to try again. `unknown` is never retryable: an unclassified
failure on a side-effecting step is the uncertain-outcome case, where the
dispatch may already have succeeded.

`target_unavailable` exists because "Chat not found" and "X not connected" need
different user actions even though both are unfixable by retrying.

### 4. Every side-effecting capability is idempotent (ADR-005)

`PublishPostInput.idempotencyKey` is derived from
`(runId, stepIndex, accountId)`. A connector checks its **publish receipt**
before dispatching and records one after a successful publish. A retry with a
known key returns the recorded result — including the real `platformPostId` and
`permalink` — instead of calling the platform again.

This matters because the run-level guard only protects *within* one run, and a
retry is a **new** run with a new id. Without the receipt, a retried step
published twice with nothing to stop it.

The order is deliberately **check → dispatch → record**:

- A crash between dispatch and record leaves no receipt, so the next attempt may
  dispatch again. That is the uncertain-outcome case, and it **fails** rather
  than reporting success.
- A failed dispatch records nothing, so a legitimate later retry is never
  suppressed.

Receipts are never expired. The table grows only with distinct step keys, a
stale receipt is harmless, and a deleted one is a double post.

---

## Current connectors

| Platform | `publish_post` | Status |
|---|---|---|
| Instagram | ✅ | legacy adapter |
| Facebook | ✅ | legacy adapter |
| Threads | ✅ | legacy adapter |
| X | ✅ | legacy adapter |
| Telegram | ✅ | legacy adapter |
| LinkedIn, TikTok, YouTube, Pinterest, Reddit | — | connect-only, empty capability set |

All five are currently served by **one adapter**
([`src/lib/connectors/legacy.ts`](../src/lib/connectors/legacy.ts)) that wraps
the existing publishers in `@/lib/publish`. No publishing behaviour changed when
it was introduced.

### The legacy bridge is temporary

`classifyLegacyError` in
[`src/lib/connectors/errors.ts`](../src/lib/connectors/errors.ts) maps the
publishers' free-text errors onto `ConnectorErrorCode`, because those publishers
predate typed errors. It is the only place in the codebase that interprets those
strings.

**Phase 3 deletes it.** Each real connector reports its platform's own taxonomy
— HTTP status, Graph `code`, Telegram `error_code` — directly. New connectors
must not grow the string table; they construct `ConnectorError` themselves.

---

## Writing a connector

1. Implement `Connector` for one `PlatformId`.
2. Declare `capabilities` honestly. An unimplemented capability is absent, not
   stubbed.
3. Return typed errors. Map the platform's codes in the connector, where the
   platform's vocabulary is allowed to exist.
4. Accept and honour `idempotencyKey` for every side-effecting capability.
5. Use `pinned-provider-fetch` for outbound calls — it carries the SSRF
   protections (`net-guard`) that every external request in this codebase
   requires.
6. Do not import from `@/lib/runtime`, `@/lib/tools`, or any UI module. The
   dependency arrow points one way.
