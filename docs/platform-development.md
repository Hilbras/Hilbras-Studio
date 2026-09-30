# Platform development

How to add a platform that can actually publish, end to end.

For the contract itself see [`connectors.md`](connectors.md). For the capability
model see [`capabilities.md`](capabilities.md).

---

## Order of work

The steps are in dependency order. Skipping ahead produces a platform that
connects but cannot act, which is the `connect_only` state five platforms are
sitting in today.

| # | Step | File |
|---|---|---|
| 1 | Register the platform | `src/lib/platforms.ts` |
| 2 | Declare its capabilities | `src/lib/platforms.ts` |
| 3 | Write the publisher | `src/lib/publish/<platform>.ts` |
| 4 | Route it | `src/lib/publish/index.ts` — one `case` in the switch |
| 5 | Test the failure modes | a new `src/lib/publish/<platform>.test.ts` — **none exist yet**, so yours is the first |
| 6 | Document it | this file, `docs/accounts.md` |

---

## 1. Register the platform

`PLATFORM_REGISTRY` in [`src/lib/platforms.ts`](../src/lib/platforms.ts) needs an
entry with:

- `id` — the stable key, lowercase, used in `account_key` (`platform:handle`)
  and in `post_targets.platform`. **Changing it after launch orphans data.**
- `name` — display name
- `accountModel` — what kind of identity this platform has, shown in the UI
- `auth` — client id/secret env names plus the authorize and token URLs and
  scopes, or `auth: "manual"` for a bot-token platform like Telegram
- `content` — `maxTextLength`, `mediaTypes`, and hard `rules`

`content.rules` and `content.maxTextLength` are not decoration. The AI layer reads
them when rewriting a draft, and a wrong limit produces content the platform
rejects at publish time — after the user has approved it.

The `PLATFORM_IDS` array order is user-visible (it drives the Composer's platform
list and the Accounts page), so append rather than inserting mid-array.

## 2. Declare capabilities honestly

```ts
myplatform: {
  capabilities: ["create_post", "publish_post", "get_account"],
  accountSelection: "account",
},
```

Start with an **empty** array and only add a capability when step 3 is done and
tested. An empty set is a valid, honest state: the platform connects, and the
Composer will not offer it. `connect_only` is not a failure — it is the truthful
description of a platform with no publisher.

`accountSelection` is how the user picks *which* identity to post as:
`"account"` for a single profile, `"page"` for a Page picker, `"chat"` for a
channel or chat, `"none"` when there is nothing to select.

## 3. Write the publisher

Add `publishToMyPlatform(userId, text, imageUrl, accountKey)` in a new
`src/lib/publish/myplatform.ts`, then add one `case` to the switch in
`routePublishForUser` in [`src/lib/publish/index.ts`](../src/lib/publish/index.ts)
and one import beside the others.

The switch is the only registration step: `publishForUser` and
`publishToAllForUser` are the module's public surface, and both route through
it. Every result is passed through `sanitizePublishResult` on the way out, so a
publisher cannot bypass the server-side result validation by being called
directly — which is the reason to call the exported function rather than your
own.

Copy the shape of an existing publisher (`instagram.ts` for media,
`threads.ts` for the Meta Graph helpers in `shared.ts`); they differ in their API
calls and agree on everything else.

Four requirements:

- **Outbound calls go through `pinned-provider-fetch`.** It carries the
  DNS-pinning and SSRF protections (`net-guard`) every external request in this
  codebase requires. A bare `fetch` to a user-supplied URL is a vulnerability.
- **Resolve the account from `accountKey`, and never guess.** Call
  `getConnectedAccount(userId, platform, accountKey)`. It resolves
  `accounts → connections` and returns `not_connected` for a key that matches
  nothing rather than falling back to a different account, and refuses to pick
  when several accounts are enabled and no key was given. Both behaviours are
  deliberate: a post that lands on the wrong account is worse than one that does
  not land, and a silent fallback is how that happens. See
  [`docs/accounts.md`](accounts.md).
- **Return a `PublishResult` with the platform's own `postId` and `url` when it
  gives you one.** `publish_receipts` stores both, so a retried step can report
  where the post actually went instead of a bare "already done".
- **Handle every documented failure.** A new publisher that only handles success
  makes every error path report `unknown`, which is non-retryable — the run fails
  with a message that says nothing about why.

**None of the five publishers has a test file.** The failure modes above are
therefore documentation, not enforced behaviour: `src/lib/publish/` currently
holds no `*.test.ts`, and the only connector tests are
`src/lib/connectors/errors.test.ts` and `registry.test.ts`, which cover the
error taxonomy and the registry rather than any platform's API calls. A new
publisher with a test file is therefore the *only* publisher whose failure
mapping is verified — write it, and treat the list above as the specification
rather than as a description of what already happens.

## 4. The adapter

There is nothing to write. `src/lib/connectors/legacy.ts` builds a `Connector`
for every `PlatformId` and derives its capability set from the registry.

That file is named for what it is — a bridge over publishers that predate typed
errors — and it is scheduled for replacement. **New publishers should not add
behaviour to it.** The long-term shape is one directory per platform
(`src/lib/connectors/myplatform/`) exporting a `Connector` that constructs its
own `ConnectorError` from the platform's own taxonomy, registered in
`registry.ts`.

## 5. Test the failure modes

Unit tests in `src/lib/connectors/` run with no network and no database. Cover,
at minimum:

- The success path returns `ok: true` with the platform's id and permalink.
- An expired grant → `expired`, `retryable: false`.
- A missing or renamed account → `target_unavailable`, **not** `not_connected`.
  These send the user to different places.
- Throttling → `rate_limited`, `retryable: true`.
- Rejected content → `invalid_content`, `retryable: false`. Retrying the same
  text will be rejected again.
- A re-delivery with a known `idempotencyKey` returns the receipt and does not
  dispatch.

If the platform is added to `registry.test.ts`'s "unimplemented" list — a
capability no platform provides — that test will fail until the capability is
handled or the platform is excluded deliberately. Read the failure; it is the
test doing its job.

## 6. Documentation

- `docs/accounts.md` — if the platform's account model is unusual (Pages,
  chats), say how `account_key` is derived.
- `docs/connectors.md` — the capability table.
- `CHANGELOG.md` — under `[Unreleased]`, with migration notes if a migration is
  involved.

---

## Definition of done

- [ ] The platform appears in Accounts and completes its auth flow.
- [ ] `capabilities` lists only what is implemented **and tested**.
- [ ] A post publishes to a real account and the result carries the platform's
      `postId` and `url`.
- [ ] A re-delivered step does not publish twice.
- [ ] Every error path returns a specific `ConnectorErrorCode`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` pass.
- [ ] Docs and `CHANGELOG.md` updated in the same change.
