# Execution policies

What a user may configure about what the Runtime is allowed to do unattended.
Implemented in [`src/lib/runtime/approval-store.ts`](../../src/lib/runtime/approval-store.ts),
with the pure rules in
[`src/lib/runtime/approvals.ts`](../../src/lib/runtime/approvals.ts).

---

## Three decisions

```ts
type PolicyDecision = "auto" | "approval" | "disabled";
```

| | Meaning |
| --- | --- |
| `auto` | Run it. Nobody is asked. |
| `approval` | Ask a person first. Once, then run it. |
| `disabled` | Do not run it. **Do not ask** — see below. |

### The default is `auto`

Every existing user publishes unattended today, and a new deployment should work
before it has been configured. A default of `approval` would mean every existing
account starts with a queue of posts nobody asked for, which is not a safe
default so much as a broken one.

### A `deny` fails without asking

Asking a human to approve something their own policy forbids is asking them to
override their own configuration, and the question would be a trap: the screen
offers a button whose only outcome is to contradict the setting that produced it.
So `disabled` settles the step immediately, with `policy_denied`.

The approval exists for actions the user has *not* ruled out. It is not an
escalation path past a decision they have already made.

---

## Two scopes

```ts
type PolicyScope = "account" | "tool";
```

A policy names one `(user, scope, scope_key)` triple. There are no NULLs, because
a NULL is a third case that nothing can reason about and the precedence is
already written and already tested.

**`account`** — `scope_key` is an account key, e.g. `x:hilbras`. "Never post
automatically to this one."

**`tool`** — `scope_key` is a tool name, e.g. `publish_post`. "Always ask before
publishing, anywhere."

---

## Precedence

`policyFor` is not new in v0.8.0 — it was written and tested in v0.3.0 for the
plan gate, and the table's only job is to produce the two maps it already reads:

```ts
if (step.targetAccount && policy.byAccount?.[step.targetAccount]) return …;
if (policy.byCapability?.[step.capability])                        return …;
return policy.defaultDecision;
```

**per-account beats per-tool beats the default.**

The reason is the shape of the mistake it prevents. A user who turns publishing
off for one noisy account means *that account*, not the capability everywhere —
and if the per-tool rule won, their one frustration would silently become a rule
about all five accounts, which is a far larger change than the one they made.

So there is exactly one implementation of precedence in the system, and it is
`policyFor`.

---

## Two refusals, both at write time

`setPolicy` returns `{ ok: false, reason }` rather than accepting a setting it
cannot honour.

### A policy may only name a tool that changes something

```ts
validatePolicyTarget(scope, key, { accountKeys })
```

A policy on `compose_post` is refused. It cannot be honoured — the text that step
writes does not exist yet, so the most the Runtime could do is approve a brief —
and **a dead setting that a user believes is live is worse than a refusal**. The
user would set it, see it saved, and believe their publishing was gated when it
was not.

The tool list is the registry's own `sideEffect` flags, so the two cannot disagree
about which tools are approvable. See
[`permissions.md`](./permissions.md#1-not-an-approvable-tool--allow).

### A policy may only name an account the user owns

A typo — `x:hilbras` for `x:hilbras` — is refused for the same reason. It would
otherwise be stored, displayed as a configured rule, and never apply to anything,
which is the same failure as above with a different cause.

**Clearing is always allowed**, including for an account the user no longer
holds. A disconnected account must not leave behind a policy nobody can remove,
and a stuck setting is worse than a stale one. `clearPolicy` is a delete, not a
validated write, for exactly that reason.

---

## An unrecognised value is "no rule", not a guess

```ts
if (!decision) continue;   // loadPolicy
```

`loadPolicy` coerces a stored `decision` it does not recognise by **dropping the
row**, so an unknown value resolves to the default.

The alternative is interpreting it as the nearest thing this build knows, and the
value that matters is `approval`. A settings screen written by a later build that
stored a decision this build does not have would otherwise be read here as
"ask a person" — or, worse, the reverse: a build that gains a new, stricter
decision would have older builds reading it as `auto`. Dropping the row is the
only choice that cannot publish unattended by accident.

The same rule applies to `ApprovalState` read back: an unknown state coerces to
`pending`, which is the answer that waits rather than the answer that acts.

---

## Where the policy is read

Once, at dispatch. The permission gate is the only place in the system that reads
a policy, and a policy can change between a plan being written and a step being
executed — so the reading that governs whether something happens has to be the
one immediately before it happens, not the one before the plan was persisted.

### The plan gate has a policy input, and it is deliberately not wired

`validatePlan` accepts a `policy` and will report a `disabled` step as a
`policy_disabled` issue. `planRun` does not supply one, so every plan validates
under `{ defaultDecision: "auto" }`.

That is a decision, and the reasoning is the interesting part. Reporting a
policy-disabled step to the planner is a **repair** signal, and the repair it
invites is to drop the step. For a goal targeting X and Instagram whose X policy
is `disabled`, that produces:

```
plan has an X step  →  policy_disabled  →  planner drops it
                                         →  X is a required target, nothing delivers to it
                                         →  uncovered_goal_target  →  the whole run fails
```

The Instagram post — which nobody objected to and which the policy permits —
never goes out. Whereas reading the policy at dispatch fails the X step and the
run continues to Instagram, which is the settle-independently rule every other
kind of step failure already follows.

A gate that turns a configuration into a plan-level failure is worse than a gate
that turns it into a step-level one. So the plan gate's policy input stays
available and tested, and the dispatch gate is the live one.

This also means the `decisions` array `validatePlan` returns on success has no
production reader today. It is the same shape the v0.3.0 composer consumed, kept
because the input that produces it is kept, and not yet because anything needs it.


---

## How the plan gate and the dispatch gate differ

`validatePlan` treats a `disabled` step as an issue and offers the planner one
repair. The dispatch gate treats it as a refusal and does not ask anyone. They
are the same policy read at different stages, and the difference in response is
the point: at plan time there is still a chance to do something else, and at
dispatch time there is not.

An `approval` policy is invisible to `validatePlan` — a step that needs consent
is a perfectly good step, and the planner has nothing to repair.

---

## The storage

```
execution_policies
  id           text primary key
  user_id      text → users          on delete cascade
  scope        text                  'account' | 'tool'
  scope_key    text
  decision     text
  created_at   timestamp

  unique (user_id, scope, scope_key)   index (user_id)

run_step_approvals
  id               text primary key
  run_id           text → runs           on delete cascade
  step_id          text → run_steps      on delete cascade
  user_id          text → users          on delete cascade
  tool             text
  target_account   text
  input            text                 the resolved snapshot, JSON
  state            text, default 'pending'
  decided_at       timestamp
  expires_at       timestamptz          ← compared against now() in a query
  created_at       timestamp

  unique (step_id)                       one question per step
  index (run_id)
  index (user_id, state, created_at)     the "what am I waiting on" list
  index (expires_at) where state = 'pending'   the sweeper's one scan
```

`expires_at` is the only `timestamptz` in the two tables, and it is the only one
that crosses a query boundary against `now()`. The rest are `timestamp` because
they are only ever read back as instants and compared in JavaScript, where a
session TimeZone cannot change them.

`setPolicy` is an upsert on that unique triple, so a user changing a setting
repeatedly gets one row rather than an accumulating list. `listPolicyRows` reads
them back in insertion order for a settings screen; `describePolicyTargets`
returns what may be named at all — the user's own accounts, and the approvable
tool names — so a screen cannot offer a choice that would be refused.

### A note on the overlap with `accounts.enabled`

Account-scoped `disabled` and `accounts.enabled = false` do overlapping work
today. Only one side-effecting tool exists, so there is nothing for a per-tool
policy to distinguish.

This is documented rather than resolved, because `enabled` is the better control
until there is more than one approvable tool: it is per-account by nature, it
already gates the connector resolver, and it is what the Accounts screen already
means. A per-tool policy becomes worth more than the overlap the moment a second
side-effecting tool exists — a "read analytics" connector, a DM — where one
account needs one behaviour gated and the other not.

---

## The migration

`drizzle/0013_approval_policies.sql`, purely additive: two new tables, six
indexes and four foreign keys, no backfill. There is nothing to backfill because
the default is the absence of a row, and every existing user already has the
absence.

The migration is written to be safe in either order relative to a deployment, and
it adds no column to an existing table, so an older build running against a
migrated database keeps working — it simply does not ask.

---

## Where to look

| Question | File |
| --- | --- |
| What a policy is, precedence | [`plan.ts`](../../src/lib/runtime/plan.ts) |
| Reading and writing policies | [`approval-store.ts`](../../src/lib/runtime/approval-store.ts) |
| The pure validation rules | [`approvals.ts`](../../src/lib/runtime/approvals.ts) |
| How the gate uses them | [`permissions.md`](./permissions.md) |
| The table | [`schema.ts`](../../src/db/schema.ts) |
