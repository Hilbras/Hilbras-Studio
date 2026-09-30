#!/usr/bin/env node
/**
 * Client bundle budget (remediation Task 18).
 *
 * ## What this measures, and why that way
 *
 * Next 16 builds with Turbopack, and Turbopack's per-route
 * `build-manifest.json` contains only the *shared* `rootMainFiles` — the same
 * six chunks for all 49 routes. A budget computed from those numbers reports
 * one identical figure per route and would be a budget on nothing. (That is not
 * a hypothetical: measuring it that way is how the first draft of this script
 * reported 430 KiB for every page in the app.)
 *
 * So this reads what a browser actually downloads: for each prerendered route,
 * the `<script src>` tags in its own emitted HTML, resolved against
 * `.next/static/chunks`, and summed. That is the route's first-load JS, and it
 * differs per route — the landing page carries the framer-motion landing
 * animation, the docs pages do not.
 *
 * ## Why a budget and not a report
 *
 * A number nobody checks is a number that only ever goes up. The limits below
 * are set from the measured baseline with roughly 15% of headroom, so ordinary
 * work passes and a real regression — a charting library pulled onto a public
 * page, a barrel file that stops tree-shaking — fails. Re-baselining is a
 * deliberate act: change the number in this file in the same commit that
 * explains why, so the diff records the decision.
 *
 * Dynamic (`ƒ`) routes are not measured. They are server-rendered on demand and
 * their client payload is assembled at request time, so there is no static HTML
 * to read the script tags from. They are listed in the output as unmeasured
 * rather than silently counted as zero, which would make the budget look better
 * than it is.
 *
 * Usage:
 *   node scripts/bundle-budget.mjs            # check against the limits below
 *   node scripts/bundle-budget.mjs --report   # print the table, never fail
 *   node scripts/bundle-budget.mjs --update   # rewrite the limits to the
 *                                             # measured values (re-baseline)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const NEXT = join(ROOT, ".next");

/**
 * Budgets, in kibibytes of **gzipped** first-load JS.
 *
 * Baselines measured 2026-09-30 on the Turbopack build: the heaviest
 * prerendered route is `/` at 254.1 KiB, and the largest single chunk anywhere
 * is 69.8 KiB. The limits below are those numbers plus ~15%.
 */
const BUDGET_KIB = {
  /** Every prerendered page must ship under this. */
  total: 295,
  /**
   * No single chunk may exceed this.
   *
   * The one that catches a dependency pulled in by accident. A new charting or
   * animation library lands as one 100 KiB+ chunk on whichever route first
   * imported it, and the total budget alone can absorb that across 49 routes.
   */
  largestChunk: 82,
};

/** Routes to enforce. A regression anywhere in the public surface is a regression. */
const ENFORCE_ROUTES = ["/", "/login", "/signup", "/pricing", "/privacy", "/docs"];

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report");
const update = args.has("--update");

/** Gzipped KiB, which is the unit every budget below is expressed in. */
function gzipKib(file) {
  return gzipSync(readFileSync(file), { level: 9 }).length / 1024;
}

/** Every emitted prerendered page HTML, keyed by route. */
function prerenderedPages(dir = join(NEXT, "server", "app"), acc = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      prerenderedPages(full, acc);
    } else if (entry.endsWith(".html")) {
      const route =
        "/" + relative(join(NEXT, "server", "app"), full).replace(/\.html$/, "");
      acc[route === "/index" ? "/" : route] = full;
    }
  }
  return acc;
}

/**
 * The chunks one page's HTML asks the browser to download.
 *
 * Read from the HTML rather than from a manifest, because the HTML is the only
 * place the answer is actually recorded. A `preload` link is included: the
 * browser fetches it either way, so leaving it out would understate the cost.
 */
function chunksFor(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const names = new Set();
  for (const m of html.matchAll(/\/_next\/static\/chunks\/([\w.\-]+\.js)/g)) {
    names.add(m[1]);
  }
  return [...names]
    .map((n) => join(NEXT, "static", "chunks", n))
    .filter((f) => {
      try {
        statSync(f);
        return true;
      } catch {
        return false;
      }
    });
}

function main() {
  let pages;
  try {
    pages = prerenderedPages();
  } catch {
    console.error(
      "No .next/server/app directory. Run `pnpm build` before the bundle budget.",
    );
    process.exit(2);
  }

  const rows = Object.entries(pages)
    .map(([route, htmlPath]) => {
      const files = chunksFor(htmlPath);
      const sizes = files.map((f) => ({ file: f, kib: gzipKib(f) }));
      return {
        route,
        total: sizes.reduce((n, s) => n + s.kib, 0),
        largest: sizes.reduce((m, s) => Math.max(m, s.kib), 0),
        chunks: sizes.length,
      };
    })
    .sort((a, b) => b.total - a.total);

  const k = (n) => `${n.toFixed(1)} KiB`;

  console.log("Client bundle — gzipped first-load JS per prerendered route\n");
  console.log(`${"route".padEnd(26)}${"chunks".padStart(7)}${"total".padStart(11)}${"largest".padStart(11)}`);
  console.log("-".repeat(55));
  for (const r of rows) {
    console.log(
      `${r.route.padEnd(26)}${String(r.chunks).padStart(7)}${k(r.total).padStart(11)}${k(r.largest).padStart(11)}`,
    );
  }

  if (update) {
    const worst = rows[0];
    const biggest = rows.reduce((m, r) => (r.largest > m.largest ? r : m));
    // Headroom on the *written* value, not just a comment. Re-baselining to
    // exactly today's measurement means the very next byte of growth fails CI,
    // which trains everyone to reach for `--update` instead of fixing a
    // regression — the budget stops being a signal and becomes an obstacle.
    const withHeadroom = (n) => Math.ceil(n * 1.15);

    const source = readFileSync(new URL(import.meta.url), "utf8");
    const next = source
      .replace(
        /(const BUDGET_KIB = \{[\s\S]*?total: )[\d.]+/,
        `$1${withHeadroom(worst.total)}`,
      )
      .replace(
        /(largestChunk: )[\d.]+/,
        `$1${withHeadroom(biggest.largest)}`,
      )
      // Matches both the original wording and a previous re-baseline, so
      // `--update` is idempotent rather than silently doing nothing the second
      // time it is run.
      .replace(
        / \* Baselines (?:measured|re-measured) [^\n]*\n \* prerendered route is[^\n]*\n \* is [\d.]+ KiB\. The limits below are those numbers plus ~\d+%\./,
        ` * Baselines re-measured ${new Date().toISOString().slice(0, 10)}: the\n` +
          ` * heaviest prerendered route is \`${worst.route}\` at ${worst.total.toFixed(1)} KiB, and the\n` +
          ` * largest single chunk anywhere is ${biggest.largest.toFixed(1)} KiB (\`${biggest.route}\`). The limits\n` +
          ` * below are those numbers plus ~15%.`,
      );
    writeFileSync(new URL(import.meta.url), next);
    console.log(
      `\nRe-baselined: total ${withHeadroom(worst.total)} KiB (measured ${worst.total.toFixed(1)} on ${worst.route}), ` +
        `largestChunk ${withHeadroom(biggest.largest)} KiB (measured ${biggest.largest.toFixed(1)} on ${biggest.route})`,
    );
    console.log(
      `Review the diff before committing: a re-baseline is a decision to accept ` +
        `${(withHeadroom(worst.total) - worst.total).toFixed(0)} KiB of new weight.`,
    );
    return;
  }

  if (reportOnly) return;

  const problems = [];
  for (const route of ENFORCE_ROUTES) {
    const row = rows.find((r) => r.route === route);
    if (!row) {
      console.log(`\nSKIP  ${route} — not prerendered, so not measured`);
      continue;
    }
    if (row.total > BUDGET_KIB.total) {
      problems.push(
        `${route} ships ${k(row.total)}, over the ${k(BUDGET_KIB.total)} budget`,
      );
    }
    if (row.largest > BUDGET_KIB.largestChunk) {
      problems.push(
        `${route} has a ${k(row.largest)} chunk, over the ${k(BUDGET_KIB.largestChunk)} single-chunk budget`,
      );
    }
  }

  console.log(
    `Enforced: ${ENFORCE_ROUTES.length} public routes · ` +
      `budgets ${k(BUDGET_KIB.total)} total / ${k(BUDGET_KIB.largestChunk)} largest chunk`,
  );
  console.log(
    `Not measured: server-rendered (ƒ) routes — Turbopack emits no per-route ` +
      `chunk list for them, and they are not counted as zero.`,
  );

  if (problems.length) {
    console.error(`\nBundle budget exceeded:\n  - ${problems.join("\n  - ")}`);
    console.error(
      `\nIf the growth is intended, re-baseline deliberately:\n` +
        `  node scripts/bundle-budget.mjs --update`,
    );
    process.exit(1);
  }
  console.log("\nWithin budget.");
}

main();
