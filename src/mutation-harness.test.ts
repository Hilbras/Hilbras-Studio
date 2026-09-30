import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Every mutation harness still transforms the code it names.
 *
 * ## The failure this exists to catch
 *
 * A mutation harness is a pile of `sed` expressions that break the code on
 * purpose and require a test to notice. Each one carries a `cmp` guard for the
 * case where the pattern **matches nothing** — and reports that as SKIP, which
 * counts as a failure, so a stale pattern turns CI red.
 *
 * That is the *good* direction, and it is why this rot went unnoticed for two
 * phases. What was actually lost is the coverage, quietly: `mutate-phase6.sh`
 * had a mutation asserting that a step claim is a compare-and-swap, and after
 * Phase 8 reformatted that call onto multiple lines the pattern matched nothing
 * and the harness could no longer perform the removal it was checking for.
 *
 * So this test does what the harness's own guard cannot: it applies **every**
 * expression, in the harness scripts, to the file it names, and requires that
 * each one actually changes the file. It does not run the harnesses — that is
 * tens of minutes of database containers — so it fits in the unit suite and
 * runs on every commit, catching the drift within seconds of it landing rather
 * than whenever somebody next remembers to run the harness.
 *
 * ## What it deliberately does not check
 *
 * That a mutation is *type-valid* or that it makes a test fail. A pattern can
 * match, change the file, and still be inert — replacing an expression with an
 * equivalent one — and only the harness itself can tell, which is what the
 * harness is for. This is the cheap half that makes the expensive half
 * trustworthy, and it is the half that was silently broken.
 */

const ROOT = resolve(process.cwd());
const SCRIPTS = ["mutate-phase6.sh", "mutate-phase7.sh", "mutate-phase8.sh", "mutate-task17.sh"];

const scratch = mkdtempSync(join(tmpdir(), "mutation-patterns-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Mutation {
  name: string;
  script: string;
  /** The file the mutation targets, with the harness's own variables resolved. */
  file: string;
  expression: string;
}

/**
 * Parse `mutate "name" <file> '<expr>'` out of a harness.
 *
 * Deliberately a narrow parser rather than a shell evaluation: the harnesses
 * are ours, they follow one shape, and running them to find out what they do
 * would be the thing this test exists to avoid needing.
 */
function mutationsIn(script: string): Mutation[] {
  const source = readFileSync(join(ROOT, "scripts", script), "utf8");

  // The harnesses assign their target/check variables at the top — `F="src/…"`
  // in mutate-task17.sh, `U=…`/`I=…` in the phase scripts. Matched case-
  // insensitively on the *name* so both the single-letter (`F`) and the
  // lowercase-prefixed forms resolve, and anchored on the assignment operator
  // so a `$F` that appears inside a mutation block is never mistaken for one.
  const vars: Record<string, string> = {};
  for (const m of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]+)"/gm)) {
    vars[m[1]] = m[2];
  }

  const out: Mutation[] = [];
  const block =
    /mutate "([^"]+)"\s*\\\n\s+(\S+)\s*\\\n\s+'((?:[^'\\]|\\.)*)'/g;
  for (const m of source.matchAll(block)) {
    const [, name, fileVar, expression] = m;
    // The mutation sites pass `$F` while the map is keyed `F` — the shell
    // expands it, so the parser has to do the same rather than looking up the
    // literal `$F`.
    const key = fileVar.startsWith("$") ? fileVar.slice(1) : fileVar;
    out.push({
      name,
      script,
      file: vars[key] ?? fileVar,
      expression: expression.replace(/\\'/g, "'"),
    });
  }
  return out;
}

const ALL = SCRIPTS.flatMap(mutationsIn);

describe("every mutation harness pattern still matches the code it names", () => {
  it("finds the harnesses and their mutations", () => {
    // Without this, a parser that stops matching reports "no broken patterns",
    // which is indistinguishable from all-fixed.
    expect(ALL.length).toBeGreaterThan(70);
    for (const script of SCRIPTS) {
      expect(ALL.some((m) => m.script === script), `${script} yielded no mutations`).toBe(
        true,
      );
    }
  });

  it("has a mutation for the step claim's compare-and-swap", () => {
    // Named explicitly because it is the one that was silently lost: if it goes
    // again, this says so by name rather than as one anonymous line among
    // twenty.
    const claim = ALL.filter((m) => /compare-and-swap|lease window/i.test(m.name));
    expect(
      claim.length,
      "mutate-phase6.sh should assert both that a claim is a compare-and-swap " +
        "and that it respects its lease window (ADR-009)",
    ).toBeGreaterThanOrEqual(2);
  });

  it("names a file that exists", () => {
    const missing = ALL.filter((m) => {
      try {
        execFileSync("test", ["-f", join(ROOT, m.file)]);
        return false;
      } catch {
        return true;
      }
    });

    expect(
      missing.map((m) => `${m.script}: "${m.name}" → ${m.file}`),
      "these mutations name a file that does not exist, so they cannot run",
    ).toEqual([]);
  });

  it("changes the file it names", () => {
    const inert: string[] = [];

    for (const m of ALL) {
      const target = join(ROOT, m.file);
      // A private copy: these are `sed -i` on the real tree, and a test that
      // mutates the repository to check a mutation harness would be the most
      // dangerous test in the suite.
      const copy = join(scratch, `${m.script.replace(/\W/g, "_")}_${m.name.replace(/\W/g, "_")}`);
      copyFileSync(target, copy);

      const before = readFileSync(copy, "utf8");
      try {
        execFileSync("sed", ["-i", m.expression, copy], { stdio: "pipe" });
      } catch {
        inert.push(
          `${m.script}: "${m.name}" — sed failed on ${m.file}. The expression is ` +
            `probably malformed, and the harness would report SKIP.`,
        );
        continue;
      }
      if (readFileSync(copy, "utf8") === before) {
        inert.push(
          `${m.script}: "${m.name}" — the pattern matches nothing in ${m.file}. ` +
            `The harness's own cmp guard reports this as SKIP, but the coverage it ` +
            `was checking has been silently lost since the code last moved.`,
        );
      }
    }

    expect(
      inert,
      "A mutation that changes nothing still reports 'ok' or SKIP, so a pattern " +
        "that has drifted from the code looks like coverage while checking none.\n" +
        "This is not hypothetical: one of these was broken from Phase 8 onwards.\n\n" +
        inert.join("\n\n"),
    ).toEqual([]);
  });

  // There is deliberately no "the working tree is clean" test here. An earlier
  // draft had one, and it failed for the wrong reason: a mutation harness was
  // running concurrently and had a file mutated at that moment, which is
  // indistinguishable from this test having done it. Such a test can only ever
  // be right when no harness is running and wrong when one is, so it measures
  // the machine's load rather than the code.
  //
  // Isolation is structural instead: the test copies each target into a
  // temp directory and runs `sed -i` there, so it cannot touch the repository
  // whatever else is happening. The scratch directory is removed in `afterAll`.
});
