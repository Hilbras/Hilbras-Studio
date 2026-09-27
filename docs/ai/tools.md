# The tool registry

What a step in a plan is allowed to name, and why that is a separate question
from what a platform can do.

Implemented in [`src/lib/runtime/tools.ts`](../../src/lib/runtime/tools.ts).

---

## The two vocabularies

Until v0.7.0, a step's `capability` field held a `CapabilityName`, and
`CAPABILITY_NAMES` was the list of everything legal. That was correct while
every step delegated to a platform, and it stopped being correct the moment a
plan needed a step that touches no platform at all — writing a post, choosing a
topic, summarising a feed. The roadmap's own example plan is *research → ideas →
posts → validate → publish → verify*, and five of those six steps are not
platform capabilities.

So the two are separated, and this is the whole of the separation:

| | **Capability** | **Tool** |
|---|---|---|
| Answers | what a *platform* can do | what a *step* may invoke |
| Owned by | `src/lib/platforms.ts` | `src/lib/runtime/tools.ts` |
| Gated by | the target account's platform | nothing platform-specific |
| Examples | `publish_post`, `get_posts` | `publish_post`, `compose_post` |

The namespaces overlap; they are not equal. `run_steps.capability` now holds a
**tool name**. The column keeps the name it has always had because the concept
predates the tool layer, and renaming it under a released migration would churn
every existing row for no gain.

The two names are not interchangeable. `get_account` is a real capability with no
step behind it, and the gate refuses it:

```
"get_account" is not a tool. Use one of: compose_post, publish_post.
```

---

## What a tool may not do

A `ToolSpec` has no field for a platform. There is nowhere in the type to put
`"instagram"`, and a step's destination is an *account*, resolved through the
connector registry at execution time. A test asserts the exact key set of every
`ToolSpec`, so adding a platform field fails the build rather than quietly
weakening the guarantee.

The registry is also the *offerable* set. A planner is shown these tools and
nothing else, and the plan gate accepts these tools and nothing else — so "which
capabilities exist" is one answer in one file rather than a prompt instruction
the model can be talked out of.

---

## The registry

Two tools. `capability: null` means the Runtime runs it itself with no platform
involved, which is what decides which gate applies: a tool with a capability is
additionally checked against the target account's capability set, and one
without it is not, because there is nothing about the account to check.

### `compose_post`

Writes the text of one post, fitted to the target platform's character limit and
its rules. Produces text; publishes nothing.

| Field | Type | | |
|---|---|---|---|
| `brief` | string or `$ref` | required | What the post should say: the angle, the point. Not a draft — a direction. |
| `tone` | string | optional | Voice override. |

Produces `text` and `characters`. `targetAccount` is optional and selects the
platform's limits and rules; omit it and there is no limit to fit.

### `publish_post`

Publishes text to the target account.

| Field | Type | | |
|---|---|---|---|
| `text` | string or `$ref` | required | The post text. Usually a `$ref` to an earlier `compose_post`. |
| `mediaUrl` | string or `$ref` | optional | A public image or video URL. |

Produces `platformPostId` and `permalink`.

---

## `deliversToAccount`, and why it is its own field

Only `publish_post` has `deliversToAccount: true`. The plan gate uses it to
refuse a plan that quietly skips one of a goal's accounts — a goal pointed at X
and Instagram that posts only to X looks like it worked, and this is how the
user finds out their second account went quiet.

If `compose_post` counted as coverage, a plan that drafted for both accounts and
published to neither would validate. That is the bug this field prevents.

It is a separate field rather than `capability !== null` because the meaning is
"does this step finish the delivery", and a future read-only connector tool
would otherwise be miscounted the moment it was added.

---

## Declared inputs are the planner's only documentation

Each field's `describe` is interpolated verbatim into the planner's system
prompt. A test asserts no description is shorter than ten characters, because an
empty one is a silent loss of instruction.

`maxChars` is checked at **plan** time, not execution time, so an over-long
value is a validation issue the planner is shown and can correct, instead of a
step that fails after the plan has been accepted. A `$ref` is not measured
there: its length is whatever the tool that produced it decided, and the tool
that consumes it is the one that knows the limit.

Unknown keys in `input` are ignored rather than refused. The executor reads only
the fields the tool declares, so an extra key cannot change behaviour, and
rejecting one would spend a repair attempt on a cosmetic difference between two
otherwise identical plans.

---

## Two things worth knowing before adding a tool

**A tool claiming an unknown capability is caught by a test.**
`toolCapabilityDrift()` asserts that every `capability` a tool declares exists in
`CAPABILITY_NAMES`. Without it, a typo would pass plan validation and then fail
at the last step of execution — the worst place to find out.

**Dispatch is a switch, and the default is a refusal.** In
[`executor.ts`](../../src/lib/runtime/executor.ts), `dispatchConnectorTool`
handles `publish_post` and returns `unsupported` for anything else. Adding a
capability is a new case *plus* a new tool, and a half-finished capability fails
rather than publishing something.

---

See also [`planner.md`](./planner.md) for how a plan is produced and gated, and
[`../runtime/planning.md`](../runtime/planning.md) for the orchestration.
