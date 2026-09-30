#!/usr/bin/env bash
# Task 17 mutation checks — the dashboard/analytics read layer.
#
# Same contract as `mutate-phase7.sh`: each mutation removes or inverts one
# load-bearing guarantee, runs the tests that claim to cover it, and requires
# that they FAIL. A mutation whose tests still pass means the guarantee is not
# covered — the test asserts something else, or nothing.
#
# These four readers used to live in `@/app/actions/dashboard` with no
# arguments, each resolving the ambient session itself, which is why they could
# not be called by a caller that already knew whose data it wanted — the
# Assistant's context builder, which is what forced the move. They now take a
# `userId` and put it in the `WHERE` clause, so the scoping is mechanical and
# the only way to know it holds is to run two users against one database.
#
# A dropped scope here is not a subtle regression. `getRecentActivity` returns
# post *content* — the first 80 characters of what a user wrote — and the
# Assistant's system prompt is built from it, so an unscoped read is one
# tenant's drafts pasted into another tenant's conversation.
#
# Two rules for the expressions below, both inherited from mutate-phase7.sh
# and both learned the hard way:
#
#  * **Every mutation must be type-valid.** The integration suite is transpiled,
#    not typechecked, so a mutation that references an unimported helper dies of
#    a `ReferenceError` rather than at an assertion — which reports "ok" for a
#    file that never ran. Hence `eq(col, col)` for "predicate always true".
#  * **The last check of each group is expected to be the cheapest proof.** A
#    predicate that changes the code rather than the outcome is not a mutation.
#
# Usage: scripts/mutate-task17.sh
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

  # A guard against the mutation itself being a no-op, which would make a
  # passing check look like a covering one.
  if ! sed -i "$expr" "$file"; then
    echo "SKIP  $name (sed failed)"; fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi
  if cmp -s "$file" "$backup"; then
    echo "SKIP  $name (no change: the pattern did not match)"
    fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi

  if "$@" >/tmp/mutation-task17.log 2>&1; then
    echo "HOLE  $name — still passes without it"
    fail=$((fail + 1))
  else
    echo "ok    $name — fails without it"
    pass=$((pass + 1))
  fi

  cp "$backup" "$file"; rm -f "$backup"
}

I="pnpm test:integration tests/integration"
D="$I dashboard-queries.test.ts"
F="src/lib/dashboard/queries.ts"

echo "== the dashboard reads are scoped to their caller =="

# Four reads, four separate scopes. They are checked separately because they
# fail separately: the counts read `posts`, the account list reads `accounts`,
# and a test that only seeded one table would not notice a leak in the other.

mutate "the post counts not scoped to the caller" \
  $F \
  's/^        eq(posts.userId, userId),$/        eq(posts.userId, posts.userId),/' \
  $D

mutate "the scheduled count not scoped to the caller" \
  $F \
  's/^        \.where(and(eq(posts.userId, userId), eq(posts.status, "scheduled")))$/        .where(and(eq(posts.userId, posts.userId), eq(posts.status, "scheduled")))/' \
  $D

mutate "the total-post count not scoped to the caller" \
  $F \
  's/^    \.where(eq(posts.userId, userId))$/    .where(eq(posts.userId, posts.userId))/' \
  $D

# The count, and the list behind it that carries a user's handle. Same argument,
# different consequence: a count that leaks tells you a stranger is in the
# system; a list that leaks tells you their account name. One mutation covers the
# `accounts` scope — both reads are on the same predicate, and a second sed over
# the same line would be the same mutation wearing a different name.
mutate "the connected-account count and list not scoped to the caller" \
  $F \
  's/^    \.where(eq(accounts.userId, userId))$/    .where(eq(accounts.userId, accounts.userId))/' \
  $D

# The one that carries post content. `getRecentActivity` returns the first 80
# characters of what a user wrote, and `buildAssistantSystemPrompt` interpolates
# it into a system prompt — so this is the mutation where a missed scope puts
# one tenant's drafts in another tenant's conversation.
mutate "recent activity not scoped to the caller" \
  $F \
  's/^    \.where(eq(posts.userId, userId))$/    .where(eq(posts.userId, posts.userId))/' \
  $D

mutate "the weekly chart not scoped to the caller" \
  $F \
  '/^export async function getWeeklyChartData/,/^}/ s/^        eq(posts.userId, userId),$/        eq(posts.userId, posts.userId),/' \
  $D

echo "== the weekly chart is this week =="

# A chart with no window counts all time, and it looks correct whenever
# everything is recent — which is the only state anyone eyeballs by hand. The
# test plants posts 200 days back precisely so the two answers differ.
mutate "the weekly chart counts every published post ever" \
  $F \
  '/^export async function getWeeklyChartData/,/^}/ { /^        gte(posts.publishedAt, startOfWeek),$/d }' \
  $D

# There is deliberately **no** mutation for "the weekly chart charts drafts as
# if they were published". It was written, it reported a HOLE, and the hole is
# not in the test.
#
# `getWeeklyChartData` filters on `status = "published"` *and* on
# `publishedAt BETWEEN startOfWeek AND endOfWeek`, and every writer sets
# `publishedAt` to a timestamp only on the same statement that sets the status
# to `published` — `finalize` in `scheduled-posts.ts` and the composer path in
# `actions/publish.ts` both write `publishedAt: ok ? now : null`. A row that is
# not `published` therefore has a NULL `publishedAt`, and a NULL fails the
# range predicate, so the status filter never has anything left to exclude.
#
# That makes the filter unreachable rather than untested, and the same
# reasoning `mutate-phase8.sh` records for the error-summary guard. The filter
# is kept because it is correct on its own terms — the chart means "published
# this week", not "has a timestamp this week", and a future writer that sets
# `publishedAt` without publishing should not silently change what the chart
# shows — not because a test distinguishes it. Inventing a row that violates
# the writers' invariant to make the mutation fail would be testing a state the
# application cannot produce.

echo "== a limit cannot be asked past the cap =="

# The clamp moved here from the action module, so it has to hold for every
# caller and not only the ones that remembered to apply it. Removing the cap
# turns a rendering choice into a full-table read.
mutate "the activity limit cap removed" \
  $F \
  's/^const activityLimitSchema = z.number().int().min(1).max(50).catch(5);$/const activityLimitSchema = z.number().int().min(1).catch(5);/' \
  $D

mutate "the activity limit no longer falls back when it is out of range" \
  $F \
  's/^const activityLimitSchema = z.number().int().min(1).max(50).catch(5);$/const activityLimitSchema = z.number().int().min(1).max(50);/' \
  $D

echo "== the reads are honest about state =="

# A change computed against a zero denominator is a division that becomes
# `Infinity%` or `NaN%` in a UI card, and `NaN%` is what a user sees when the
# dashboard has no previous week to compare against — the common case.
mutate "a zero previous week reads as a real percentage" \
  $F \
  's/^    if (prev === 0) return curr > 0 ? "+100%" : "—";$/    if (prev === 0) return "+100%";/' \
  $D

# The activity detail string is interpolated into the Assistant's system prompt,
# so an unbounded one is both a layout break and more of the user's content in a
# prompt than anything needs.
mutate "the activity detail stops being truncated" \
  $F \
  's/^    detail: r.content.slice(0, 80) + (r.content.length > 80 ? "…" : ""),$/    detail: r.content,/' \
  $D

# A post with no target row is the state the scheduler refuses to publish
# ("Post has no target platforms"). Dropping such a post from the activity feed
# would hide it from the very user who needs to see that something is wrong, and
# it is a plausible-looking optimisation — there is nothing to label it with.
mutate "a post with no target vanishes from the activity feed" \
  $F \
  's/^  return rows.map((r) => ({$/  return rows.filter((r) => targets.has(r.id)).map((r) => ({/' \
  $D

# The last check of each group is expected to be the cheapest proof: a mutation
# that changes the code rather than the outcome is not a mutation. Reordering
# the buckets changes nothing about the counts — every day is still counted and
# still reported — so only the assertion on the returned order can catch it.
mutate "the week does not start on Monday" \
  $F \
  's/^  const dayNames = \["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"\];$/  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];/' \
  $D

echo "== the analytics page describes one user's publishing =="

# Same scope argument, different query: this one reads post *bodies* into
# `recentPosts.text` and renders them on the caller's own screen, so an
# unscoped read shows a stranger's published posts on this user's page.
mutate "the analytics read not scoped to the caller" \
  $F \
  '/^export async function getAnalyticsData/,/^}/ s/^    .where(and(eq(posts.userId, userId), eq(posts.status, "published")))$/    .where(and(eq(posts.userId, posts.userId), eq(posts.status, "published")))/' \
  $D

# A draft is not something that went out. Without the status filter the page
# counts work in progress as published history.
mutate "the analytics page counts drafts as published" \
  $F \
  '/^export async function getAnalyticsData/,/^}/ s/^    .where(and(eq(posts.userId, userId), eq(posts.status, "published")))$/    .where(eq(posts.userId, userId))/' \
  $D

# The breakdown is a share of platform-*deliveries*, so the denominator is the
# sum of the per-platform counts. Dividing by the number of posts instead would
# give 50/50 for a post that went to two platforms and one that went to one —
# and would still look like a plausible pie chart.
mutate "the platform breakdown divides by posts instead of deliveries" \
  $F \
  's/^  const totalPosts = Object.values(platformCounts).reduce((a, b) => a + b, 0);$/  const totalPosts = publishedPosts.length;/' \
  $D

# A multi-platform post is one post and several deliveries. Counting it once
# makes the breakdown disagree with the publish stats beside it.
mutate "a multi-platform post is counted once, not per platform" \
  $F \
  '/^  const platformCounts/,+5 s/^    for (const platform of targets.get(post.id) ?? \[\]) {$/    for (const platform of (targets.get(post.id) ?? []).slice(0, 1)) {/' \
  $D

# `success` is read as `=== true` because the result is sanitized before it is
# stored. A truthy read counts the string `"true"` — and a `failed` connector
# that reported its error as data — as a publish.
mutate "a success that is not exactly true counts as published" \
  $F \
  's/^            success: r.success === true,$/            success: Boolean(r.success),/' \
  $D

# Rows published before results were stored have none. Assuming success is
# right; dropping them would make an older account look like it never published.
mutate "a post with no stored results is dropped from the outcome counts" \
  $F \
  's/^        : platforms.map((platform) => ({ platform, success: true }));$/        : [];/' \
  $D

# The permalink is what turns a row into a link to the live post. Falling back
# to any result's url would surface the URL of a *failed* attempt.
mutate "a permalink is taken from a failed result too" \
  $F \
  's/^    const url = parseResults(post.results).find((r) => r.success && r.url)?.url;$/    const url = parseResults(post.results).find((r) => r.url)?.url;/' \
  $D

# The last check of each group is expected to be the cheapest proof. Capping the
# recent-posts list at the page's own five changes nothing about which posts are
# newest, so only the length assertion can catch it.
mutate "the recent-posts list is not capped at the page's five" \
  $F \
  's/^  const recentPosts: PublishedPost\[\] = publishedPosts.slice(0, 5).map((post) => {$/  const recentPosts: PublishedPost[] = publishedPosts.slice(0, 6).map((post) => {/' \
  $D

echo
echo "covered: $pass   holes: $fail"
[ "$fail" -eq 0 ]
