# The permission gate

The one question every side effect passes through before it happens.
Implemented in [`src/lib/runtime/approval-store.ts`](../../src/lib/runtime/approval-store.ts)
(`createApprovalGate`) and called from
[`src/lib/runtime/executor.ts`](../../src/lib/runtime/executor.ts).

---

## One function, three answers

```ts
type StepPermission =
  | { kind: "allow" }
  | { kind: "needs_approval"; approvalId: string; expiresAt: Date }
  | { kind: "deny"; error: ConnectorError };
```

The gate is the *only* thing that decides, and it is built **once per run** and
passed into the executor. Not once per step: a run of six steps against one user
has one policy, and reading it six times to produce the same answer six times is
a way for a step to be dispatched under a policy that changed three steps ago.

```ts
// src/lib/runtime/inngest/functions.ts
const deps = {
  resolveConnector: resolverForUser(userId),
  approval: createApprovalGate(userId),   // one gate, one policy read
  runLocalTool: createLocalToolRunner({ spend, limits: DEFAULT_SPEND_LIMITS }),
};
```

A suspended run builds a fresh gate, and that is the case that matters: a user who
switches to `disabled` while their post is waiting gets a gate that has read the
new policy when the resume arrives.

---

## Where it sits, and why the position is the point

```
executeStep
  │
  ├─ 1. parse the stored input
  ├─ 2. resolve $refs            ── the text now exists
  ├─ 3. ██ PERMISSION GATE ██     ── "you may not do this"
  ├─ 4. resolve the connector    ── "you might not be able to"
  ├─ 5. dispatch
  └─ 6. settle
```

**After resolution.** The gate has to be handed the text a person will read, and
before resolution that text is `{"$ref": {"step": 0, "field": "text"}}`. Asking
someone to approve a reference is asking them to approve a JSON object — see
[`approvals.md`](./approvals.md#the-approval-holds-the-resolved-text).

**Before the connector lookup.** "You may not do this" beats "you might not be
able to", and a forbidden action should not cost a database read. A user who has
disabled an account gets the same answer whether the platform is reachable or
not, and a disabled account never produces a 401 on its way to being politely
refused.

The executor holds the gate as a required dependency rather than consulting the
store itself. Two reasons, and the second is the important one:

1. The gate is a *policy decision*, and policy resolution already existed and was
   already tested in `plan.ts` (`policyFor`). Putting it behind one function means
   there is one implementation of the precedence rather than two that drift.
2. `executeStep` stays a pure function of its inputs, so its 34 unit tests run
   without a database and can be written as a state machine. Every one of the
   security-relevant cases — denied, asked, already approved, already rejected —
   is a line in a test file rather than a fixture.

---

## The dependency is required, with no default

```ts
export interface ExecutorDeps {
  resolveConnector: ...;
  /** Required. There is deliberately no default that allows everything. */
  approval: StepPermissionGate;
  runLocalTool: LocalToolRunner;
}
```

A permissive default means forgotten wiring publishes unattended, and the
forgotten wiring is invisible: the code compiles, the type is satisfied, the tests
pass, and the only symptom is a post that went out without anyone being asked.

v0.7.0 shipped a `defaultDeps` — a registry-only resolver and, as of this phase,
a gate that allowed everything. Nothing imported it. It is deleted, and the note
where it used to be says why, because an unused object that assembles a working
set of dependencies is an invitation rather than dead code.

`ExecutorDeps` is satisfied in full, or not at all. The wiring is one line.

---

## The order inside the gate

```ts
const tool = approvableToolFor(request.tool);
if (!tool) return { kind: "allow" };              // 1. not approvable at all

const decision = policyFor(await policy(), …);    // 2. one read, memoised
if (decision === "disabled") return { kind: "deny", … };   // 3.

const existing = await getStepApproval(request.stepId);
if (existing?.state === "approved")  return { kind: "allow" };
if (existing?.state === "rejected")  return { kind: "deny", … };
if (existing?.state === "expired")   return { kind: "deny", … };
if (existing) return { kind: "needs_approval", … };        // 4. pending
if (decision === "auto") return { kind: "allow" };
return { kind: "needs_approval", … };                       // 5. ask
```

### 1. Not an approvable tool → allow

`compose_post` writes text that exists only inside the run. A question in front of
it would have no consequence behind it.

### 2. The policy is read once

`loadPolicy` returns the two maps `policyFor` already consumes, and the promise is
memoised on the gate rather than awaited per step.

### 3. `disabled` is checked *before* a recorded approval

This ordering is the whole reason the gate is not a lookup of "has this step been
approved yet".

> A user leaves a post waiting for approval, then disables publishing while it
> waits, then comes back and approves — because the approval screen is still open
> and the post still looks like a question they have to answer.

If the recorded approval were checked first, that post publishes. The user turned
publishing off, and approving afterwards is not a way around it: **an approval is
consent to a permitted action, not a licence to perform a forbidden one.**

`policy_denied` is also the right *error*, not just the right branch — a disabled
action is a refusal the user configured, and the run history should say so.

### 4. A pending approval is asked about, not re-asked

The gate is idempotent per step. The second visit to a step that is already
pending returns the *same* `approvalId` and the *original* deadline rather than
opening a second question, which is what makes the executor safe to run twice.

An overdue approval is still `pending` here — the sweeper is what turns it into
`expired` — so a run that reaches a step whose window has closed asks about it
again rather than publishing. The answer is a refusal either way; publishing
because nobody got round to the sweeper would be a timeout that approves.

### 5. Otherwise the policy decides

`auto` allows. `approval` creates the question.

---

## What the executor does with each answer

| Answer | `StepExecution` | The step becomes |
| --- | --- | --- |
| `allow` | dispatches | `completed` or `failed`, per the connector |
| `needs_approval` | `awaiting_approval` | `awaiting_approval`, the run suspends |
| `deny` | `failed` with the error | `failed`, `retryable: false` |

`deny` is never retryable. A policy is a configuration, not a transient fault, and
retrying it would send three events to a queue asking a question the user has
already answered by configuring the system.

`StepExecution` is an exhaustive discriminated union on `state`, with the unused
fields spelled `undefined` rather than omitted — so `result.error?.code` still
reads at the call sites that have not narrowed, and narrowing is enforced
everywhere else.

---

## The error codes

Three new ones, all in `ConnectorErrorCode`, all non-retryable:

| Code | Meaning |
| --- | --- |
| `policy_denied` | The user's policy forbids this. Nothing was asked, and nothing will be. |
| `approval_rejected` | A person was asked and said no. |
| `approval_expired` | A person was asked and the window closed. |

The third one is the reason a timeout is an error code rather than a special
case: an expired approval is *not* an approval, and the run history needs to be
able to say which of the three things happened.

They are ordinary `ConnectorError`s, which means the step settles through the
same path as any other failure, the run reports the failure, and the
settle-independently rule applies with no special case in the run loop.

---

## Where to look

| Question | File |
| --- | --- |
| The three answers and their order | [`approval-store.ts`](../../src/lib/runtime/approval-store.ts) |
| Where the gate is called | [`executor.ts`](../../src/lib/runtime/executor.ts) |
| The precedence rules | [`plan.ts`](../../src/lib/runtime/plan.ts) |
| What the policies *are* | [`policies.md`](./policies.md) |
| What happens after the question | [`approvals.md`](./approvals.md) |
