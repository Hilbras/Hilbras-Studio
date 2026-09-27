# Capabilities

What a platform can do, expressed in words the Runtime — not a platform — owns.

**Source of truth:**
[`src/lib/platforms.ts`](../src/lib/platforms.ts) (`PUBLISHING_CAPABILITIES`).
This document explains the model; the registry is the model.

---

## The vocabulary

```ts
type CapabilityName =
  | "create_post"
  | "publish_post"
  | "get_posts"
  | "get_account"
  | "delete_post";
```

A capability is a promise about **behaviour**, not about an endpoint.
`get_posts` means the Runtime can read a feed in the standard shape — whether the
platform underneath is Graph, REST, or has no read API at all. It does not mean
"there is a `GET /feed` somewhere".

This is what lets the Runtime stay ignorant. A Goal says "read my X mentions"; it
does not know or care that X's API calls that `GET /2/users/:id/tweets`, and that
Threads' equivalent takes three calls and returns a cursor.

### Declared, not implemented

All five names are declared. Only three are implemented, by five platforms:

| Platform | Declared capabilities |
|---|---|
| Instagram, Facebook, Threads, X, Telegram | `create_post`, `publish_post`, `get_account` |
| LinkedIn, TikTok, YouTube, Pinterest, Reddit | *(none)* |

`get_posts` and `delete_post` are implemented by nobody. They stay in the
vocabulary on purpose: a name that does not exist cannot be *mistaken* for one
that does, and a plan naming one is refused at the gate with a precise message
instead of being silently reinterpreted as something else.

---

## Three levels, and why they differ

| Level | Question | Source |
|---|---|---|
| Platform | What could this platform do? | `PUBLISHING_CAPABILITIES` |
| Account | What may *this* account do? | `accounts.capabilities` |
| Connector | What has this adapter implemented? | derived from the platform |

They are not the same, and conflating them is how a disabled account ends up
publishing.

**Platform** is a statement about the platform. **Account** is a statement about
one user's grant on it: a Facebook Page and a Facebook profile are different
account types with different rights, so the account's set is *narrower* than the
platform's and is stored per row. **Connector** is a statement about this build —
a capability in the vocabulary with no implementation must not be advertised by
the adapter that would perform it.

`capabilitiesForAccount()` in
[`src/lib/accounts/store.ts`](../src/lib/accounts/store.ts) resolves the middle
one: the account's stored set, falling back to the platform's for an account
backfilled before its capabilities were resolved.

---

## The registry is the authority

`lookupCapability(platform, capability)` in
[`src/lib/connectors/registry.ts`](../src/lib/connectors/registry.ts) is the gate
every capability call passes through. It reads the registry, **not** the
adapter's self-declared list.

That direction is the whole point. An adapter is the module that performs the
publishing. If it could grant itself the capability to publish, adding a
publisher would be a one-line edit inside the thing doing the publishing, with
nothing to review it against. The registry is the authority precisely because it
cannot be edited from inside a platform adapter.

`src/lib/connectors/registry.test.ts` fails if an adapter's declared set drifts
from the registry's.

### Why the reason matters

The gate distinguishes two failures that look alike to a user and lead to
completely different places:

```
not_connected   → "reconnect this account"      (the user's grant)
unsupported     → "this platform cannot post"   (the product's limits)
```

Telling someone who *is* connected to LinkedIn that their connection is broken
sends them to re-authorise an app that will still not post. A Goal targeting a
connect-only platform is refused at **planning** time with that distinction
intact, rather than failing halfway through execution.

---

## Checking a capability

```ts
import { platformSupports, capabilitiesForPlatform } from "@/lib/platforms";

// Anywhere in the UI or a service. No adapter, no database, no server graph.
platformSupports("x", "publish_post");        // true
platformSupports("linkedin", "publish_post"); // false — connect-only
platformSupports("myspace", "publish_post");  // false — unknown id
platformSupports("x", "get_posts");          // false — nobody implements it

capabilitiesForPlatform("x");       // ["create_post", "publish_post", "get_account"]
capabilitiesForPlatform("linkedin") // []
```

All three helpers answer safely for an id the build does not know, returning
empty or `false` rather than throwing. A platform id reaches this code from
stored rows, and a stored row can name a platform this build has never heard of.

In the Runtime, go through the gate instead:

```ts
const gate = lookupCapability(connector.platform, "publish_post");
if (!gate.ok) return failed({ code: gate.code, message: gate.message, retryable: false });
```

---

## Adding a capability

1. Add the name to `CAPABILITY_NAMES` — only if it is genuinely part of the
   standard vocabulary. A capability one platform needs and no other can express
   is a platform feature, not a capability.
2. Declare it in `PUBLISHING_CAPABILITIES` for each platform that supports it.
   Leave the others alone; absence is the honest default.
3. Implement it on the adapters that declare it, and add it to the account
   backfill if it is not `create_post`/`publish_post`/`get_account`.
4. Extend `registry.test.ts` — in particular, any capability that is not
   implemented everywhere needs a case asserting the unimplemented platforms
   refuse it.

Step 4 is not optional bookkeeping. The "no platform implements this yet" test in
that file is written against the full `PLATFORM_IDS` list, so a new name with no
implementation is caught automatically; a new name that *some* platform
implements needs the asymmetry spelled out.
