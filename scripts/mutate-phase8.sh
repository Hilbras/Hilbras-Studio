#!/usr/bin/env bash
# Phase 8 mutation checks.
#
# Each mutation removes or inverts one guarantee this release added, runs
# whatever is supposed to notice, and requires that it FAIL. A mutation whose
# checks still pass means the guarantee is not actually covered — the test
# asserts something else, or nothing.
#
# Phase 8 was a hardening phase, so the shape here is different from Phase 7's.
# Phase 7 mutated predicates inside `WHERE` clauses, because a dropped scope is a
# silent data breach. Phase 8's mutations are the *absence* of a guard: a lease
# that is not checked, a signature that is not verified, a deadline that never
# fires, a secret whose length is not validated. Each of those fails by the
# system working perfectly and doing the wrong thing, which is why they are worth
# this much ceremony.
#
# The rules below are the same two that Phase 7's harness learned the hard way,
# and they are repeated because they are the reason a mutation harness can lie:
#
#  * **Every mutation must be type-valid.** The integration suite is transpiled,
#    not typechecked, so a mutation that references an unimported helper dies of
#    a `ReferenceError` rather than at an assertion. That would report "ok" for a
#    file that no longer runs, which is the harness lying in the safe-looking
#    direction.
#  * **Do not nest `s///` inside a range address.** Use the `{ /pat/d }` block
#    form so the two do not share a delimiter. The `cmp` guard only catches
#    patterns that matched nothing, so a silently malformed mutation reads as a
#    passing mutation.
#
# Usage: scripts/mutate-phase8.sh
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

# mutate <name> <file> <sed-expr> <check-command...>
mutate() {
  local name="$1" file="$2" expr="$3"; shift 3
  local backup
  backup="$(mktemp)"
  cp "$file" "$backup"

  if ! sed -i "$expr" "$file"; then
    echo "SKIP  $name (sed failed)"; fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi
  if cmp -s "$file" "$backup"; then
    echo "SKIP  $name (no change: the pattern did not match)"
    fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi

  # A mutation that does not even parse is not a mutation. It makes every test in
  # the file skip, the suite exits non-zero, and the branch below would report
  # "ok — fails without it" for a change that only proved the harness can lie.
  #
  # esbuild parses without resolving, so this catches the `syntax error` half of
  # the type-validity rule. It cannot catch the other half — a mutation naming an
  # identifier that does not exist is valid syntax and dies of a `ReferenceError`
  # at runtime, whether or not it changed the behaviour under test. That one is
  # fixed by hand, which is why every expression below uses only names that exist
  # in the file it rewrites.
  if ! ./node_modules/.bin/esbuild --outfile=/dev/null "$file" >/dev/null 2>&1; then
    echo "SKIP  $name (the mutated file does not parse — it would skip, not fail)"
    fail=$((fail + 1)); cp "$backup" "$file"; rm -f "$backup"; return
  fi

  # A check that was *killed* has not proven anything. Without this, an outer
  # `timeout` reaching its wall mid-run makes the check exit non-zero, and the
  # branch below reports "ok — fails without it" for a mutation that was never
  # actually evaluated. Exit 124 is `timeout`'s own code; anything ≥128 is a
  # signal. Both are reported as holes — the unsafe direction — because a hole is
  # a prompt to look and a false pass is silence.
  timeout 600 "$@" >/tmp/mutation-phase8.log 2>&1
  local status=$?
  if [ "$status" -eq 124 ] || [ "$status" -ge 128 ]; then
    echo "HOLE  $name — the check was killed (exit $status), not failed"
    fail=$((fail + 1))
  elif [ "$status" -eq 0 ]; then
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
A="$I approvals.test.ts"
C="$I chat.test.ts"

echo "== a claim is a lease, not a flag =="

# The bug this release exists for. `claimStep` compares against the state the
# caller *read*, so without the lease a second invocation reading `running`
# re-claims it and both publish. The v0.8.0 test claimed twice from `pending`,
# which never exercised this state.
mutate "a running step is claimable again immediately" \
  src/lib/runtime/service.ts \
  's/^        from === "running"$/        false/' \
  $A

# The other half. A lease that expires too late turns a double-execution bug into
# a stuck run, which is why the constant is five minutes and not five seconds.
mutate "the lease never expires" \
  src/lib/runtime/service.ts \
  's/^          ? lt(runSteps.startedAt, new Date(now.getTime() - STEP_CLAIM_LEASE_MS))$/          ? lt(runSteps.startedAt, new Date(0))/' \
  $A

echo "== the matcher and the route list cannot drift =="

# Phase 7 added four routes to `PROTECTED` and not to the matcher, so the four
# screens that release was about never reached the middleware. Every page checks
# its own session, so nothing failed — which is exactly why only a test catches it.
mutate "a protected route dropped from the middleware matcher" \
  src/proxy.ts \
  's|^    "/runtime/:path\*",$||' \
  $U src/proxy.test.ts

mutate "an auth page dropped from the middleware matcher" \
  src/proxy.ts \
  's|^    "/login",$||' \
  $U src/proxy.test.ts

echo "== the OAuth state is signed and expiring =="

# Unsigned state is the account-link CSRF. The callback's only check used to be
# `state.userId === session.id`, so knowing a victim's user id was the whole of
# the defence.
mutate "the state signature not verified" \
  src/lib/oauth-state.ts \
  '/^  if (!verifySignature(payload, signature, secret)) return null;$/d' \
  $U src/lib/oauth-state.test.ts

# Verification happening *after* the parse would mean treating attacker input as
# state before establishing it is ours.
mutate "a signature checked with the wrong key" \
  src/lib/oauth-state.ts \
  's/^  const expected = Buffer.from(sign(payload, secret), "base64url");$/  const expected = Buffer.from(sign(payload, secret + "x"), "base64url");/' \
  $U src/lib/oauth-state.test.ts

# A state that never expires is a state that can be replayed whenever the
# attacker gets around to it — which is exactly the window a short max-age exists
# to close.
mutate "the state never expires" \
  src/lib/oauth-state.ts \
  '/^  if (now - candidate.iat >= STATE_MAX_AGE_MS) return null;$/d' \
  $U src/lib/oauth-state.test.ts

# The future check is what stops a wrong clock extending the window, and it is the
# one a reviewer reads as redundant because the signature already verified.
mutate "a state dated in the future accepted" \
  src/lib/oauth-state.ts \
  '/^  if (candidate.iat > now + CLOCK_SKEW_MS) return null;$/d' \
  $U src/lib/oauth-state.test.ts

echo "== secrets are checked for strength, not just presence =="

# `ENCRYPTION_KEY=a` was a valid production configuration until this release: it
# encrypted every token in the database with something scrypt could not rescue,
# and nothing reported a problem. The block is six lines, so the range is `+5` —
# one short of that orphans the closing brace and the file stops parsing.
mutate "the encryption key's length not validated" \
  src/lib/crypto.ts \
  '/^  if (isProduction && effective.length < MIN_KEY_CHARS) {$/,+5d' \
  $U src/lib/crypto.test.ts

# The same gap, on the key that signs every session cookie and the OAuth state.
mutate "the auth secret's length not validated" \
  src/lib/secret-key.ts \
  '/^  if (isProduction && effective.length < MIN_AUTH_SECRET_CHARS) {$/,+5d' \
  $U src/lib/secret-key.test.ts

# A presence check that also accepts the empty string, which is what "not checked"
# looks like when the test only exercises a missing variable.
mutate "an empty key accepted in production" \
  src/lib/crypto.ts \
  's/^  if (!raw && isProduction) {$/  if (false) {/' \
  $U src/lib/crypto.test.ts

echo "== the crypto round trip holds for an empty secret =="

# Found by writing the tests, not by reading the code: `encryptSecret("")` writes
# a zero-length ciphertext, `base64url("")` is `""`, and a truthiness check treats
# that as a missing part. The module could write a value it refused to read.
mutate "the malformed-payload check back to a truthiness test" \
  src/lib/crypto.ts \
  's/^  if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {$/  if (!ivPart || !tagPart || !dataPart) {/' \
  $U src/lib/crypto.test.ts

# Reused IVs are the failure that throws nothing. GCM collapses entirely under a
# reused nonce and the only evidence is this line of source.
mutate "a fixed IV instead of a fresh one per call" \
  src/lib/crypto.ts \
  's/^  const iv = crypto.randomBytes(IV_BYTES);$/  const iv = Buffer.alloc(IV_BYTES);/' \
  $U src/lib/crypto.test.ts

echo "== every outbound request has a deadline =="

# `fetch` waits forever by default, and publishing is sequential within a run, so
# one hung call is a run holding a claimed step and never settling.
mutate "the deadline never fires" \
  src/lib/http.ts \
  's/^    () => controller.abort(new HttpTimeoutError(url, timeoutMs)),$/    () => undefined,/' \
  $U src/lib/http.test.ts

# Replacing the caller's signal would make the helper a way of *extending* a
# request past the limit its own author set. Written as `if (false)` rather than
# as a block delete of the `if (callerSignal) { … }` body: deleting the range
# orphans the closing `});` and the file stops parsing, so the suite skips
# instead of failing and the harness would call that a pass.
mutate "the caller's own deadline ignored" \
  src/lib/http.ts \
  's/^  if (callerSignal) {$/  if (false) {/' \
  $U src/lib/http.test.ts

# A timeout reported as a generic failure is what a user sees as "fetch failed",
# and a caller's own cancel reported as a platform timeout is worse than either.
mutate "a caller's cancel reported as a platform timeout" \
  src/lib/http.ts \
  's/^    if (controller.signal.aborted && !callerSignal?.aborted) {$/    if (controller.signal.aborted) {/' \
  $U src/lib/http.test.ts

# The error names the host because outbound URLs carry `?access_token=…`, and a
# timeout is exactly the error a user pastes into a support ticket.
mutate "the timeout error quoting the full URL" \
  src/lib/http.ts \
  's/^      `Request to ${hostOf(url)} did not complete within ${timeoutMs}ms. ` +$/      `Request to ${url} did not complete within ${timeoutMs}ms. ` +/' \
  $U src/lib/http.test.ts

# The guard against a twenty-eighth connector being written without a deadline.
# This mutation is the guard itself, so it fails by the test that watches source.
mutate "one connector back to a bare fetch" \
  src/lib/connection-health.ts \
  's/await fetchWithTimeout(/await fetch(/' \
  $U src/lib/http.test.ts

echo "== a security boundary is in the query, not the caller =="

# Session ids are minted client-side, so they are attacker-supplied. Each of
# these was a function that enforced nothing on its own and relied on the caller
# having called `ensureSession` first.
mutate "reading a transcript not scoped to its owner" \
  src/lib/chat.ts \
  's/^    \.where(and(eq(chatMessages.sessionId, sessionId), eq(chatSessions.userId, userId)))$/    .where(eq(chatMessages.sessionId, sessionId))/' \
  $C

mutate "appending to a transcript not checked for ownership" \
  src/lib/chat.ts \
  '/^  await assertOwnedSession(userId, sessionId);$/d' \
  $C

# `touchSession` and `saveSummary` hold the identical text, so the range form is
# used to target one at a time — the `s///` inside a range address is the
# nesting this harness warns about.
mutate "touching a session not scoped to its owner" \
  src/lib/chat.ts \
  '/^export async function touchSession/,/^}/ s/eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)/eq(chatSessions.id, sessionId)/' \
  $C

mutate "saving a summary not scoped to its owner" \
  src/lib/chat.ts \
  '/^export async function saveSummary/,/^}/ s/eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)/eq(chatSessions.id, sessionId)/' \
  $C

echo "== a failed run says why =="

# `runs.error_summary` was declared in v0.5.0, selected, typed and rendered — and
# nothing ever wrote it, so every failed run showed an empty error panel.
#
# Written as `...(false ? … : {})` rather than as a deleted line. Deleting the
# spread leaves a bare `...,` in the object literal, which is a *syntax* error:
# the file fails to transpile, every test in it is skipped, and the suite exits
# non-zero. The harness would call that "ok" for a mutation that proved nothing.
# The conditional is type-valid and leaves the surrounding code intact.
mutate "the error summary never written" \
  src/lib/runtime/service.ts \
  's/^      \.\.\.(result.to === "failed" && summary ? { errorSummary: summary } : {}),$/      ...(false ? { errorSummary: summary } : {}),/' \
  $A

# There is deliberately **no** mutation for "the error summary written on every
# outcome". There is no reachable behaviour for it: `summary` is only ever
# non-undefined on a `fail` event, and a `failed` run is terminal, so a run can
# never carry a summary and then succeed. Dropping the `result.to === "failed"`
# guard from the `.set()` is therefore inert, and an inert mutation that the
# suite does not catch is indistinguishable from a hole — so it is not run. The
# guard is kept because it is correct on its own terms, not because a test
# distinguishes it.

echo
echo "covered: $pass   holes: $fail"
[ "$fail" -eq 0 ]
