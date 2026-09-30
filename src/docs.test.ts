import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Documentation that points at files which no longer exist (remediation Task 16).
 *
 * ## Why this is a test and not a proofread
 *
 * `docs/platform-development.md` is the document a developer follows to add a
 * platform. For months after `src/lib/publish.ts` was split into a directory it
 * still said "write your publisher in `src/lib/publish.ts`" and linked to it —
 * so the first instruction of the main onboarding path sent a new contributor to
 * a file that had not existed since v0.3.0. Nothing caught it: the link is not
 * validated by the build, the doc renders fine, and a reader who does not
 * already know the layout has no way to tell the path is wrong.
 *
 * The same class of rot appeared in this repository's own history: the
 * architecture doc's "retire this" table still listed `src/lib/mock-data.ts` as
 * pending long after it was deleted, so the table read as a live to-do.
 *
 * ## What counts as a reference
 *
 * A backticked token ending in a source extension. The rule is deliberately
 * narrow, because a false positive here is a test failure that argues with the
 * author:
 *
 *  * Only `.ts`, `.tsx`, `.sql`, `.mjs`, and `.sh` — a reference to a
 *    non-existent `.png` in prose is not a broken instruction.
 *  * Only whole-token matches, so `lib/state.ts` inside a longer path is not
 *    extracted on its own.
 *  * **Deleted files named in a historical record are allowed.** ADR-004
 *    describes a writer being moved out of `actions/credentials.ts`; that file
 *    is gone and the sentence is still true and still worth keeping. The
 *    `HISTORICAL_ALLOWLIST` below is what a deletion adds to, and adding an entry
 *    is a decision to keep a record rather than a way to silence a failure.
 *
 * ## What this does not check
 *
 * That the prose is *accurate*, only that the files it names exist. A doc can
 * point at a real file and still describe the wrong behaviour; only reading it
 * catches that.
 */

const ROOT = resolve(process.cwd());

/** Directories whose markdown is checked. */
const DOC_ROOTS = ["docs", "src/app/docs"];

/** Plus the top-level documents, which are not in a directory of their own. */
const TOP_LEVEL_DOCS = ["README.md", "ROADMAP.md", "CHANGELOG.md"];

/** Extensions that make a backticked token a file reference. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".sql", ".mjs", ".sh"]);

/**
 * Directories a bare path is resolved against, in the order a reader would try
 * them. `src/` first because that is how the docs write most paths; the rest
 * cover the short forms (`lib/state.ts`, `runtime/view.ts`) that appear once a
 * document is already talking about `lib/`.
 */
const RESOLUTION_ROOTS = [
  "src",
  "src/lib",
  "src/lib/runtime",
  "src/lib/publish",
  "src/lib/goals",
  "src/lib/ai",
  "src/lib/connectors",
  "src/lib/accounts",
  "src/lib/inbox",
  "src/app",
  "src/app/actions",
  "src/components",
  "src/db",
  "tests/integration",
  "scripts",
  "drizzle",
  "docs",
];

/**
 * Paths that are named on purpose and do not exist.
 *
 * Each is either a record of something that was deleted, or a template the
 * reader is meant to substitute into. Removing an entry here without replacing
 * the reference is how this test becomes decoration.
 */
const HISTORICAL_ALLOWLIST = new Set([
  // Deleted, and the sentence describing why it was deleted is still true.
  "src/lib/mock-data.ts",
  "actions/credentials.ts",
  "app/actions/credentials.ts",
  "actions/dashboard.ts",
  "actions/analytics.ts",
  "app/actions/dashboard.ts",
  "app/actions/analytics.ts",
  // A placeholder in testing instructions: "unit tests live next to the code
  // as `foo.test.ts`". Not a broken link.
  "foo.test.ts",
  "tests/integration/foo.test.ts",
  // A template in the platform how-to: the reader substitutes their own platform.
  "src/lib/publish/myplatform.ts",
  // Template paths in the same how-to, written with a placeholder extension.
  "src/lib/publish/<platform>.ts",
  "src/lib/publish/<platform>.test.ts",
  "src/lib/connectors/myplatform/",
  "src/lib/connectors/myplatform",
]);

/** Every markdown file under the checked roots, plus the top-level documents. */
function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const full = join(ROOT, dir, entry);
      if (statSync(full).isDirectory()) walk(relative(ROOT, full));
      else if (extname(entry) === ".md") out.push(full);
    }
  };
  for (const dir of DOC_ROOTS) walk(dir);

  // `src/app/docs/*/page.tsx` holds the in-app guide as JSX rather than markdown,
  // so its backticked <code> tokens are checked the same way.
  for (const entry of readdirSync(join(ROOT, "src/app/docs"))) {
    const page = join(ROOT, "src/app/docs", entry, "page.tsx");
    if (existsSync(page)) out.push(page);
  }

  for (const name of TOP_LEVEL_DOCS) {
    const p = join(ROOT, name);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Backticked tokens that look like file references. */
function referencesIn(source: string): string[] {
  const out = new Set<string>();
  // A backticked span, optionally several tokens inside one span.
  for (const m of source.matchAll(/`([^`\n]+)`/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (CODE_EXTENSIONS.has(extname(token)) && /^[a-zA-Z0-9_./<>-]+\.[a-z]+$/.test(token)) {
        out.add(token);
      }
    }
  }
  // JSX <code>…</code>, for the in-app guide. HTML entities are decoded first:
  // the JSX spells a literal `<` as `&lt;`, so a template written in the markdown
  // version of the same sentence and one written in the JSX version have to
  // normalize to the same token or the allowlist needs two entries for one path.
  for (const m of source.matchAll(/<code>([^<]+)<\/code>/g)) {
    const token = decodeEntities(m[1].trim());
    if (CODE_EXTENSIONS.has(extname(token))) out.add(token);
  }
  return [...out];
}

/** `&lt;` → `<`, so a JSX template matches its markdown equivalent. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function resolves(ref: string): boolean {
  if (existsSync(join(ROOT, ref))) return true;
  // A directory reference (`src/lib/connectors/myplatform/`) is a template, not
  // a file, and is allowlisted above; anything else must resolve as a file.
  return RESOLUTION_ROOTS.some((root) => existsSync(join(ROOT, root, ref)));
}

describe("documentation points at files that exist", () => {
  const files = docFiles();

  it("finds the documents to check", () => {
    // Without this, a change to the file discovery would make every rule below
    // pass by checking nothing.
    expect(files.length).toBeGreaterThan(15);
  });

  it("has no reference to a missing file", () => {
    const broken: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const ref of referencesIn(source)) {
        if (HISTORICAL_ALLOWLIST.has(ref)) continue;
        if (resolves(ref)) continue;
        const line = source.slice(0, source.indexOf(ref)).split("\n").length;
        broken.push(`${relative(ROOT, file)}:${line} → \`${ref}\``);
      }
    }

    expect(
      broken,
      `These files are named in the documentation but do not exist. A reader ` +
        `following one is sent nowhere, and nothing else in the toolchain ` +
        `notices — the link renders, the build passes, and the doc looks fine.\n\n` +
        `If the file was deleted and the sentence is still true history, add it to ` +
        `HISTORICAL_ALLOWLIST in this file with why the record is worth keeping.\n\n` +
        broken.join("\n"),
    ).toEqual([]);
  });

  it("does not carry an allowlist entry for a file that exists again", () => {
    // An allowlist entry that is no longer needed is worse than none: it looks
    // like a live exception and hides the next stale reference that reuses the
    // name. `myplatform` and `<platform>` are templates, so they are exempt.
    const resurrected = [...HISTORICAL_ALLOWLIST].filter((ref) => {
      if (ref.includes("<platform>") || ref.includes("myplatform")) return false;
      return resolves(ref);
    });

    expect(
      resurrected,
      `These are allowlisted as missing but exist. Remove them from ` +
        `HISTORICAL_ALLOWLIST — an unnecessary exception reads as a live one.`,
    ).toEqual([]);
  });
});
