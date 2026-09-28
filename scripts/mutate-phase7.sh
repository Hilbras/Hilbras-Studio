#!/usr/bin/env bash
# Phase 7 mutation checks.
#
# Each mutation removes or inverts one load-bearing guarantee, runs whatever is
# supposed to notice, and requires that it FAIL. A mutation whose checks still
# pass means the guarantee is not actually covered — the test asserts something
# else, or nothing.
#
# Phase 7 added a *read layer*, so most of these remove a scope or a state
# predicate from a `WHERE` clause. That is the shape the whole release is about:
# `runtime/service.ts` has readers that are deliberately unscoped because the
# executor cannot ask whose run it is, and `runtime/queries.ts` exists so a page
# cannot reach them by accident. A dropped filter is not a subtle regression — it
# is one tenant's plan, step input, and drafts in another tenant's browser — and
# it is the kind of thing that passes every unit test in the repo, which is why
# these run against the database.
#
# Two rules for the expressions below, both learned the hard way:
#
#  * **Every mutation must be type-valid.** The integration suite is transpiled,
#    not typechecked, so a mutation that references an unimported helper dies of
#    a `ReferenceError` rather than at an assertion. That would report "ok" for
#    a file that no longer runs, which is the harness lying in the safe-looking
#    direction. Hence `eq(col, col)` for "predicate always true" rather than a
#    `sql`true`` that would need an import.
#  * **The last check of each group is expected to be the cheapest proof.** A
#    predicate that changes the code rather than the outcome is not a mutation.
#
# The final three checks are not test-suite checks at all: the status tables and
# the client/server import boundary are enforced by the compiler, so their
# mutations are expected to break `typecheck` and `build` instead.
#
# Usage: scripts/mutate-phase7.sh
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

# mutate <name> <file> <sed-expr> <check-command...>
#
# The `cmp` guard catches a sed pattern that matched nothing. It cannot catch a
# pattern that matched but was semantically inert — adding a duplicate object key
# changes the file and changes no behaviour — so each expression below is written
# to alter an outcome the named checks actually assert.
mutate() {
  local name="$1" file="$2" expr="$3"; shift 3
  local backup
  backup="$(mktemp)"
  cp "$file" "$backup"

  # A guard against the mutation itself being a no-op, which would make a passing
  # check look like a covering one.
  if ! sed -i "$expr" "$file"; then
    echo "SKIP  $name (sed failed)"; fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi
  if cmp -s "$file" "$backup"; then
    echo "SKIP  $name (no change: the pattern did not match)"
    fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi

  if "$@" >/tmp/mutation-phase7.log 2>&1; then
    echo "HOLE  $name — still passes without it"
    fail=$((fail + 1))
  else
    echo "ok    $name — fails without it"
    pass=$((pass + 1))
  fi

  cp "$backup" "$file"; rm -f "$backup"
}

U="pnpm vitest run"
I="pnpm test:integration tests/integration"
Q="$I queries.test.ts"

# "always true" without importing `sql`. Written as a block delete rather than a
# nested `s///` so the range address and the substitution do not share a
# delimiter, and as a delete rather than a rewrite so the two `count*` functions
# can be targeted one at a time despite holding identical text.
SCOPE_PREDICATE='^        eq(runStepApprovals.userId, userId),$'

echo "== the read layer is scoped to its owner =="

# Each of these is a one-token deletion in a different query, and they are
# separately load-bearing: a goal list that leaks is a smaller breach than a run
# log, and only the run-log filter is checked by a test that reads step input
# back out.

mutate "listRuns not scoped to the caller" \
  src/lib/runtime/queries.ts \
  's/^  const filters = \[eq(runs.userId, userId)\];$/  const filters = [];/' \
  $Q

mutate "getRunDetail not scoped to the caller" \
  src/lib/runtime/queries.ts \
  's/^    \.where(and(eq(runs.id, runId), eq(runs.userId, userId)))$/    .where(eq(runs.id, runId))/' \
  $Q

mutate "the dashboard's goal counts not scoped to the caller" \
  src/lib/runtime/queries.ts \
  's/eq(goals.userId, userId)/eq(goals.userId, goals.userId)/' \
  $Q

echo "== the dashboard counts rows it owns, in the states that matter =="

mutate "pending approvals counted across every tenant" \
  src/lib/runtime/queries.ts \
  "/^async function countPendingApprovals/,/^}/ { /$SCOPE_PREDICATE/d }" \
  $Q

mutate "overdue approvals counted across every tenant" \
  src/lib/runtime/queries.ts \
  "/^async function countOverdueApprovals/,/^}/ { /$SCOPE_PREDICATE/d }" \
  $Q

# The window closes *at* the deadline, so the boundary case is the one that
# matters. A sampled test only catches an error at least a sample wide, which is
# why the test sits exactly on the boundary rather than near it.
mutate "'overdue' stops counting the deadline itself" \
  src/lib/runtime/queries.ts \
  's/^        lte(runStepApprovals.expiresAt, now),$/        lte(runStepApprovals.expiresAt, new Date(now.getTime() - 1)),/' \
  $Q

mutate "an already-expired approval still counted as pending" \
  src/lib/runtime/queries.ts \
  '/^async function countPendingApprovals/,/^}/ s/^        eq(runStepApprovals.state, "pending"),$/        eq(runStepApprovals.state, runStepApprovals.state),/' \
  $Q

# A run holding a question is not doing anything. Counting it as in flight is how
# a user reads "in flight: 2" when one of them is waiting on them.
mutate "a run waiting on a person counts as in flight" \
  src/lib/runtime/queries.ts \
  's/^  const inFlight = (\["pending", "running"\] as const).reduce($/  const inFlight = (["pending", "running", "awaiting_approval"] as const).reduce(/' \
  $Q

# A goal naming an account that cannot publish is the one Runtime problem that
# never appears in the run history, because no run is ever created for it.
mutate "a goal that cannot act is not counted" \
  src/lib/runtime/queries.ts \
  's/^      if (targets.length === 0 || targets.some((key) => !keys.has(key))) {$/      if (false) {/' \
  $Q

echo "== the question a run is blocked on =="

# A run can hold several approval rows over its life — asked, expired, asked
# again on a retry. Without the state filter the screen shows answered questions
# next to the open one.
mutate "the pending question read without its state filter" \
  src/lib/runtime/queries.ts \
  '/^export async function getRunDetail/,/^}/ s/^        eq(runStepApprovals.state, "pending"),$/        eq(runStepApprovals.state, runStepApprovals.state),/' \
  $Q

echo "== a list cannot be asked past the cap =="

mutate "the limit cap removed" \
  src/lib/runtime/queries.ts \
  's/^  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);$/  return Math.max(Math.trunc(limit), 1);/' \
  $Q

echo "== the deadline is computed with the server's own comparison =="

# The whole point of `approvalDeadlineView` calling `isOverdue` is that the
# countdown and the decision cannot disagree about the boundary. Re-deriving the
# comparison with a different operator is the exact bug it exists to prevent: the
# screen says open, the server says closed, and the user is refused by the button
# they were watching.
mutate "the screen re-derives the deadline comparison" \
  src/lib/runtime/view.ts \
  's/^  const overdue = isOverdue(expiresAt, now);$/  const overdue = expiresAt.getTime() < now.getTime();/' \
  $U src/lib/runtime/view.test.ts

echo "== waking the queue is best-effort =="

mutate "a failed send reported as a failed approval" \
  src/lib/runtime/inngest/wake.ts \
  '/^  } catch {$/,+3d' \
  $U src/lib/runtime/inngest/wake.test.ts

echo "== a new state is a compile error (typecheck, not a test) =="

mutate "a state with no entry in the status table" \
  src/lib/runtime/view.ts \
  '/^export const EXECUTION_STATUS/,/^};/ { /^  pending: {$/,+4d }' \
  pnpm typecheck

mutate "a goal status with no entry in the status table" \
  src/lib/runtime/view.ts \
  '/^export const GOAL_STATUS/,/^};/ { /^  active: {$/,+4d }' \
  pnpm typecheck

echo "== the status vocabulary is pure, so a client may import it (build) =="

# `goals/service.ts` is server-only. If the status vocabulary lived there, every
# client component wanting to label a goal could not import it, and the fix
# written under deadline pressure is to copy the list — which is how three copies
# of the same labels drift apart. The build is what stops that, so the build is
# the check.
mutate "the status table reads a server-only module" \
  src/lib/runtime/view.ts \
  's|^import { GOAL_STATUSES, type GoalStatus } from "../goals/validation";$|import { GOAL_STATUSES, type GoalStatus } from "../goals/service";|' \
  pnpm build

echo
echo "covered: $pass   holes: $fail"
[ "$fail" -eq 0 ]
