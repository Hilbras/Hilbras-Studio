#!/usr/bin/env bash
# Phase 6 mutation checks.
#
# Each mutation removes or inverts one load-bearing guarantee, runs the tests that
# claim to cover it, and requires that they FAIL. A mutation whose tests still
# pass means the guarantee is not actually covered — the test asserts something
# else, or nothing.
#
# Usage: scripts/mutate-phase6.sh
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

# mutation <name> <file> <sed-expr> <test-command...>
#
# The `cmp` guard catches a sed pattern that matched nothing. It cannot catch a
# pattern that matched but was semantically inert — adding a duplicate object key
# changes the file and changes no behaviour — so each expression below is written
# to alter an outcome the named tests actually assert.
mutate() {
  local name="$1" file="$2" expr="$3"; shift 3
  local backup
  backup="$(mktemp)"
  cp "$file" "$backup"

  # A guard against the mutation itself being a no-op, which would make a passing
  # test suite look like a covering one.
  if ! sed -i "$expr" "$file"; then
    echo "SKIP  $name (sed failed)"; fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi
  if cmp -s "$file" "$backup"; then
    echo "SKIP  $name (no change: the pattern did not match)"
    fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi

  if "$@" >/tmp/mutation.log 2>&1; then
    echo "HOLE  $name — tests still pass without it"
    fail=$((fail + 1))
  else
    echo "ok    $name — fails without it"
    pass=$((pass + 1))
  fi

  cp "$backup" "$file"; rm -f "$backup"
}

U="pnpm vitest run"
I="pnpm test:integration tests/integration"

echo "== the permission gate =="

mutate "gate never called (publish proceeds without consent)" \
  src/lib/runtime/executor.ts \
  '/if (permission.kind === "needs_approval") {/,+2d' \
  $U src/lib/runtime/executor.test.ts

mutate "gate asked about the raw \$ref instead of the resolved text" \
  src/lib/runtime/executor.ts \
  's/    input,$/    input: stored as Record<string, unknown>,/' \
  $U src/lib/runtime/executor.test.ts

mutate "policy 'disabled' checked after a recorded approval" \
  src/lib/runtime/approval-store.ts \
  's/^    if (decision === "disabled") {$/    if (false) {/' \
  $I approvals.test.ts

mutate "no ownership check on a decision" \
  src/lib/runtime/approval-store.ts \
  's/^  if (approval.userId !== input.userId) {$/  if (false) {/' \
  $I approvals.test.ts

mutate "second answer overwrites the first" \
  src/lib/runtime/approval-store.ts \
  '/^        \/\/ The condition, not just the value read above/,+3d' \
  $I approvals.test.ts

mutate "an expired question still answerable" \
  src/lib/runtime/approval-store.ts \
  's/^  if (isOverdue(approval.expiresAt, now)) {$/  if (false) {/' \
  $I approvals.test.ts

mutate "the deadline recomputed at read time instead of stamped" \
  src/lib/runtime/approval-store.ts \
  's/      expiresAt: approvalDeadline(now),/      expiresAt: approvalDeadline(new Date()),/' \
  $I approvals.test.ts

mutate "a policy on somebody else's account is accepted" \
  src/lib/runtime/approval-store.ts \
  's/^  if (!target.ok) return { ok: false, reason: target.reason };$/  if (!target.ok) { target = { ok: true }; }/' \
  $I approvals.test.ts

mutate "an unrecognised stored decision read as a real one" \
  src/lib/runtime/approval-store.ts \
  's/^    if (!decision) continue;$/    if (!decision) decision = "approval" as PolicyDecision;/' \
  $I approvals.test.ts

mutate "the sweeper closes nothing" \
  src/lib/runtime/approval-store.ts \
  's/^        lte(runStepApprovals.expiresAt, now),$/        gt(runStepApprovals.expiresAt, now),/' \
  $I approvals.test.ts

mutate "a decided-but-unpicked-up question is not found" \
  src/lib/runtime/approval-store.ts \
  's/^        eq(runSteps.state, "awaiting_approval"),$/        ne(runSteps.state, "awaiting_approval"),/' \
  $I approvals.test.ts

echo "== the edit =="

mutate "an edit skips the plan's own validator" \
  src/lib/runtime/approvals.ts \
  's/^  const problems = validateToolInput(tool, merged);$/  const problems: string[] = [];/' \
  $U src/lib/runtime/approvals.test.ts

mutate "a human can add a media URL at the approval screen" \
  src/lib/runtime/tools.ts \
  's/^      maxChars: 2_048,$/      maxChars: 2_048,\n      editable: true,/' \
  $U src/lib/runtime/tools.test.ts

mutate "a delivering tool becomes unapprovable" \
  src/lib/runtime/tools.ts \
  's/^  sideEffect: true,$/  sideEffect: false,/' \
  $U src/lib/runtime/tools.test.ts

mutate "the gate checks the account before asking permission" \
  src/lib/runtime/executor.ts \
  's/^  const permission = await deps.approval({$/  const permission = { kind: "allow" as const }; await deps.approval({/' \
  $U src/lib/runtime/executor.test.ts

mutate "a refused question is asked again instead of refused" \
  src/lib/runtime/approval-store.ts \
  's/^    if (existing?.state === "rejected") {$/    if (false) {/' \
  $I approvals.test.ts

echo "== suspension =="

mutate "a rejected step cancels the whole run" \
  src/lib/runtime/state.ts \
  's/^    reject: "running",$/    reject: "cancelled",/' \
  $U src/lib/runtime/state.test.ts

mutate "a step claim is not a compare-and-swap" \
  src/lib/runtime/service.ts \
  's/^    .where(and(eq(runSteps.id, stepId), eq(runSteps.state, from)))$/    .where(eq(runSteps.id, stepId))/' \
  $I approvals.test.ts

mutate "a released claim stays released to everyone" \
  src/lib/runtime/service.ts \
  's/^    .where(and(eq(runSteps.id, stepId), eq(runSteps.state, "running")))$/    .where(eq(runSteps.id, stepId))/' \
  $I approvals.test.ts

echo
echo "covered: $pass   holes: $fail"
[ "$fail" -eq 0 ]
