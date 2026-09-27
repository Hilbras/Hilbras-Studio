# Releasing

Every completed phase ships a real GitHub release. This is the operational
runbook. The rule itself is ADR-007 in
[`architecture.md`](./architecture.md#adr-007--semantic-versioning-with-a-per-phase-release-gate).

**Standing rule: after every phase, update GitHub with a release.** A phase is
not done when the code works — it is done when the release exists.

---

## The gate

```bash
pnpm release:check          # validates the version in package.json
pnpm release:check -- 0.3.0 # validates a specific version
```

It fails if any of these is untrue, and it runs **before** a tag exists rather
than after:

- `package.json` is at the version being released
- `docs/architecture.md` declares the same current version (ADR-007 keeps them
  in lockstep)
- `CHANGELOG.md` has an entry for this version
- that entry is **dated**, not left as `Unreleased`
- `[Unreleased]` holds nothing substantive, so no work leaks into the wrong
  version
- the working tree is clean — a tag captures a commit, so anything uncommitted
  would silently not be in the release
- the tag does not already exist
- `HEAD` is not yet pushed, so the commit and the tag publish together
- no `.env`, `.db`, or `tsbuildinfo` file is tracked

It does **not** run the test suite, and it does not publish. CI is the
authority on green; the tag is only cut from a run that passed.

---

## Procedure

### 1. Finish the phase

Every checkbox in the phase's `ROADMAP.md` section is ticked, and its
documentation exists. A half-finished phase does not get a release — it gets a
commit, and the release comes when the phase is actually done.

### 2. Update the changelog

Move the work from `[Unreleased]` into a new dated heading:

```markdown
## [0.3.0] — 2026-10-04

### Features
- ...

### Breaking Changes
None.
```

Sections, in order: **What's New · Features · Improvements · Bug Fixes ·
Breaking Changes · Migration Notes · Documentation**. Omit a section only when
it is genuinely empty, and never omit *Migration Notes* without saying why.

Add the compare links at the bottom:

```markdown
[Unreleased]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.2.0...v0.3.0
```

### 3. Bump the version

`package.json` **and** the `**Current version:**` line in
`docs/architecture.md`, in the same commit. `release:check` verifies they
agree.

### 4. Commit, then verify, then tag

```bash
git add -A
git commit -m "v0.3.0 — Runtime Foundation"
pnpm release:check
git tag -a v0.3.0 -m "v0.3.0 — Runtime Foundation"
```

### 5. Push and wait for CI

```bash
git push origin main --follow-tags
gh run watch
```

Do not proceed on a red run. The tag is a promise that the tagged commit passed
the full gate — lint, typecheck, unit, integration, build, migrations, audit.

### 6. Publish the release

Write release notes to a file and publish them:

```bash
gh release create v0.3.0 \
  --title "v0.3.0 — Runtime Foundation" \
  --notes-file /tmp/notes.md
```

Notes follow the same section order as the changelog, and are written for
someone who has not read the commits.

### 7. Start the next phase

Open a fresh `[Unreleased]` heading in `CHANGELOG.md`.

---

## Tag integrity

`v*` tags are protected by a repository ruleset, so a published version cannot
be moved or deleted. If a release is wrong, publish a new one:

```bash
# Never: git tag -f v0.3.0 && git push --force
gh release create v0.3.1 --title "v0.3.1 — Hotfix" --notes-file /tmp/notes.md
```

A force-pushed tag would make every clone that already fetched it disagree with
the published release, and the protection exists to make that impossible by
accident.

---

## Pre-1.0 versioning

`v0.x` minors may contain breaking changes; patch releases are backward
compatible. This is the conventional meaning and it is honest here, because the
data model does change across Phases 2 and 4.

`v1.0.0` begins the stability promise: minor bumps become backward compatible,
and anything breaking requires `v2.0.0`.
