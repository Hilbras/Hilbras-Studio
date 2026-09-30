/**
 * Release preflight — ADR-007.
 *
 * A phase is not done until a release exists, and a release must not be made
 * from a tree that cannot honestly claim to be releasable. This script checks
 * the mechanical preconditions so a forgotten changelog entry or a stale
 * version bump fails loudly *before* a tag exists, rather than being
 * discovered on the published release.
 *
 * It does not check whether the work is any good, and it does not publish
 * anything. Those are human judgements. What it guarantees is that the machine-
 * checkable claims — "tests pass", "the tree is clean", "the changelog names
 * this version" — are actually true at the moment of release.
 *
 * Usage:
 *   pnpm release:check              # validate the current package version
 *   pnpm release:check -- 0.3.0     # validate a specific version
 *
 * Exit code 0 means safe to tag. Non-zero lists everything that is not.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const failures = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    notes.push(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(`  FAIL  ${label}\n          ${error.message}`);
  }
}

const read = (path) => readFileSync(resolve(root, path), "utf8");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const targetVersion = (() => {
  const flagIndex = process.argv.indexOf("--");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1].replace(/^v/, "");
  }
  return JSON.parse(read("package.json")).version;
})();

const tag = `v${targetVersion}`;

console.log(`\nRelease preflight for ${tag}\n`);

// --- version consistency -------------------------------------------------
check("package.json version is the one being released", () => {
  const current = JSON.parse(read("package.json")).version;
  if (current !== targetVersion) {
    throw new Error(
      `package.json is at ${current}, but ${targetVersion} was requested. ` +
        `Bump the version in the same commit as the changelog (ADR-007).`,
    );
  }
  return current;
});

check("architecture.md declares the same current version", () => {
  const match = read("docs/architecture.md").match(
    /\*\*Current version:\*\*\s*v?([0-9]+\.[0-9]+\.[0-9]+)/,
  );
  if (!match) throw new Error("no **Current version:** line found");
  if (match[1] !== targetVersion) {
    throw new Error(
      `docs/architecture.md says v${match[1]}; ADR-007 requires it to move ` +
        `with package.json.`,
    );
  }
  return `v${match[1]}`;
});

// --- changelog -----------------------------------------------------------
check("CHANGELOG has an entry for this version", () => {
  if (!read("CHANGELOG.md").includes(`[${targetVersion}]`)) {
    throw new Error(`no [${targetVersion}] heading in CHANGELOG.md`);
  }
});

check("CHANGELOG entry is dated, not left as Unreleased", () => {
  const pattern = new RegExp(`## \\[${targetVersion}\\] — (?!Unreleased)[^\\n]+`);
  if (!pattern.test(read("CHANGELOG.md"))) {
    throw new Error(
      `the [${targetVersion}] heading is undated or says "Unreleased". ` +
        `A release must carry its publication date.`,
    );
  }
});

check("CHANGELOG has no leftover [Unreleased] content for this version", () => {
  const changelog = read("CHANGELOG.md");
  const unreleased =
    changelog.split("## [Unreleased]")[1]?.split("## [")[0] ?? "";
  // A heading with nothing but a compare link beneath it is the correct
  // post-release state. Anything else means unreleased work would be published
  // under someone else's version number.
  const substantive = unreleased
    .replace(/\[[^\]]*\]:\s*\S+/g, "")
    .replace(/^\s*$/gm, "")
    .trim();
  if (substantive && substantive !== "Nothing yet.") {
    throw new Error(
      `[Unreleased] still has content:\n${substantive}\n` +
        `          Move it under [${targetVersion}] before tagging.`,
    );
  }
});

// --- git state -----------------------------------------------------------
check("working tree is clean", () => {
  const status = git("status", "--porcelain");
  if (status) {
    throw new Error(
      `${status.split("\n").length} uncommitted change(s). A tag captures a ` +
        `commit, so anything uncommitted would not be in the release.`,
    );
  }
});

check("the tag does not already exist", () => {
  const existing = git("tag", "--list", tag);
  if (existing) throw new Error(`${tag} already exists`);
});

/**
 * The tag must point at a commit the remote already has.
 *
 * A tag on an unpushed commit publishes nothing: `git push --tags` would send
 * the tag, but a clone would resolve it to a commit it cannot fetch, and the
 * release would exist without its contents.
 *
 * This check was previously inverted — it threw when HEAD *equalled* the remote
 * while its message told you to push, so with any upstream configured it could
 * never pass. Found by running the gate for v0.5.0, not by reading it.
 */
check("HEAD is pushed to its upstream", () => {
  const sha = git("rev-parse", "HEAD");
  let remote;
  try {
    remote = git("rev-parse", "@{u}");
  } catch {
    return "no upstream configured — skipping";
  }
  if (sha !== remote) {
    throw new Error(
      `HEAD (${sha.slice(0, 7)}) is not on ${remote}. Push the release commit ` +
        "before tagging, so the tag and the commit are published together.",
    );
  }
  return sha.slice(0, 7);
});

// --- secrets -------------------------------------------------------------
check("no environment or database file is tracked", () => {
  const tracked = git("ls-files");
  const offenders = tracked
    .split("\n")
    .filter((f) => f && !f.endsWith(".env.example"))
    .filter((f) => /(^|\/)\.env|\.db$|\.db-(shm|wal)$|tsbuildinfo$/.test(f));
  if (offenders.length) {
    throw new Error(
      `files that must never be committed: ${offenders.join(", ")}`,
    );
  }
});

// --- mutation harnesses --------------------------------------------------
//
// The harnesses are the evidence behind several ADR claims, and one of them
// (`mutate-phase6.sh`, that a step claim is a compare-and-swap) sat broken
// from Phase 8 until 2026-09-30 without anybody noticing — it takes tens of
// minutes, so it does not run on every push.
//
// This does not run them either; it records *that they were run* and how
// recently, which is the half that was missing. A release asserts properties
// its evidence has to support, and a mutation count that nobody re-derives
// before a tag is a claim in the same category as a changelog entry that
// nobody wrote.
//
// A missing stamp is a warning rather than a failure, so a release from a clean
// tree is not blocked by bookkeeping — but a stamp that is *older than the
// code it covers* is a failure, because the evidence predates the change it is
// being used to support.
const HARNESS_STAMP = ".mutation-harness-verified";

check("mutation harnesses were run against this tree", () => {
  let stamped;
  try {
    stamped = read(HARNESS_STAMP).trim();
  } catch {
    notes.push(
      `no ${HARNESS_STAMP} — run scripts/mutate-phase{6,7,8}.sh and ` +
        `scripts/mutate-task17.sh, then write the date to ${HARNESS_STAMP}`,
    );
    return;
  }

  const stamp = new Date(stamped);
  if (Number.isNaN(stamp.getTime())) {
    throw new Error(`${HARNESS_STAMP} does not contain a parseable date: "${stamped}"`);
  }

  // Newest commit touching the tree. If the evidence is older than the code, the
  // evidence says nothing about the code about to be tagged.
  //
  // Compared as **calendar dates**, not instants. The stamp is a day — nobody
  // re-runs twenty minutes of containers twice in one afternoon — and comparing
  // `2026-09-30` against a commit made at `16:52` would call every same-day
  // stamp stale, which trains the reader to write tomorrow's date instead.
  const lastTouched = git("log", "-1", "--format=%cI").trim();
  const lastDay = lastTouched.slice(0, 10);
  if (stamped < lastDay) {
    throw new Error(
      `the harnesses were last run on ${stamped} but the tree has changed since ` +
        `(last commit ${lastDay}). Re-run them before tagging — the coverage they ` +
        `provide does not describe this code.`,
    );
  }
  notes.push(`mutation harnesses verified ${stamped}`);
});

// --- report --------------------------------------------------------------
for (const note of notes) console.log(note);
if (failures.length) {
  console.log("");
  for (const failure of failures) console.log(failure);
  console.log(`\n${failures.length} check(s) failed. Do not tag.\n`);
  process.exit(1);
}
console.log(`\nAll checks passed. ${tag} is safe to tag and release.\n`);

