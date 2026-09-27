# What crosses into model output

The exact set of a user's data that leaves the deployment on every planning
call. Implemented in [`src/lib/ai/context.ts`](../../src/lib/ai/context.ts).

This module is separate from the prompt on purpose. The prompt is prose; this is
data. Keeping them apart means the list of facts that cross into a third party's
inference can be read, reviewed, and tested on its own terms — which matters
more than usual here, because this is the boundary where a user's account list
and a user's own words go out.

---

## What crosses

| | Source | As |
|---|---|---|
| Goal title | `goals.title` | verbatim |
| Goal statement | `goals.statement` | **verbatim, never summarised or rephrased** |
| Account id | `platform:handle` | verbatim |
| Platform name, handle | platform registry | display only |
| Character limit | `PLATFORM_REGISTRY[…].content.maxTextLength` | or "no stated character limit" |
| Platform rules | `PLATFORM_REGISTRY[…].content.rules` | joined with ` | ` |
| Recent firings | this goal's last 5 runs | slot, run state, step count, failed tool |
| Refusal reasons | on a repair attempt only | the gate's own issue text |

## What does not

- **Credentials and tokens.** A step resolves its connector at execution time,
  from the account row. Nothing token-shaped is ever a planner input.
- **Any account outside this goal's target list.** Not the user's other
  accounts, not other users'. The list is built from `goal.targetAccounts` and
  nothing is appended to it.
- **Step content of any kind.** No labels, no `input`, no written text.
- **Error text.** See below.
- **The Assistant's memory**, the `posts` table, and the compose drafts a user
  may have saved by hand.

### Why previous posts are absent

A planner shown what it wrote last time is measurably worse at writing something
new. The standard fix for repetition is to feed the model its own history — and
that would mean handing it the user's entire published archive on every firing,
to solve a problem Phase 6's approval flow and Phase 7's review UI address
better.

`listFiringHistory` reduces a run to whether it worked: the slot, the state, how
many steps it had, and which tool failed. The planner can notice "the last three
firings all died at publish_post" and change its approach, and cannot recover a
single word of what it published.

This is a Phase 5 decision, and it is reversible in one place —
`listFiringHistory` in [`goals/service.ts`](../../src/lib/goals/service.ts).

### Why the failure is a tool name and not a message

A run's `errorSummary` can contain a connector's own text, and a connector
message can contain whatever the platform chose to echo back. The failed step is
therefore reported as a *tool name* from a closed set this build already knows:

```
- 2026-09-25T10:00Z: failed (2 steps) — a step failed at publish_post
```

The run's own state and its failed step are rendered as separate facts, because a
run can be finished and still contain a failed step, and the two send a planner
different directions. Running them together as `failed at publish_post` reads as
though the *run* failed with that state.

### The in-flight run is excluded

`listFiringHistory` is called with `excludeRunId` set to the run being planned.
Without it, a goal's own firing appears in its own context as "pending, 0 steps"
— noise at best, and a prompt to second-guess a plan still being produced.

---

## The statement is data the model is instructed to follow

The goal's statement is the one place genuinely untrusted text enters the prompt,
and it is text the model is *told to follow* — it is the brief. A statement
containing something that reads like a second set of instructions must not widen
its own permissions.

It cannot. The gate checks the resulting plan against the account list and the
tool registry regardless of what the statement said, so the blast radius of a
crafted statement is a refused plan, not an unwanted post. Every value is
interpolated inside a tagged block so the model can tell where the user's words
begin and end.

---

## The rendered prompt

```xml
<goal>
  <title>Weekly build lessons</title>
  <statement>Post once a week about what we learned shipping.</statement>
</goal>

<accounts>
  - id: x:hilbras  (X, @hilbras)
    limit: at most 280 characters
    rules: Be direct | No external links
  - id: instagram:hilbras  (Instagram, @hilbras)
    limit: at most 2200 characters
</accounts>

<recent_firings>
  - 2026-09-26T10:00Z: completed (4 steps)
  - 2026-09-25T10:00Z: failed (2 steps) — a step failed at publish_post
</recent_firings>
```

On a repair attempt, one more block appears:

```xml
<why_the_last_plan_was_refused>
  - Step 1: "instagram:hilbras" cannot publish post.
</why_the_last_plan_was_refused>
```

It is absent on the first attempt, and its absence is stated. A planner told
"here is why that failed" when nothing has failed will invent a failure to fix.

---

## Platform facts come from the registry, not a connector

`describePlatformFor` reads `PLATFORM_REGISTRY` rather than asking a connector.
This runs before any account is resolved and has to work for a platform whose
adapter has not been consulted yet. A platform this build does not know gets the
honest answer — no limit, no rules — rather than a guess, and `compose_post`
then has no limit to fit and writes what it is asked to.

---

See also [`planner.md`](./planner.md) and
[`../security.md`](../security.md).
