import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static guards for the properties no runtime assertion can see.
 *
 * Each rule below is a *shape* — a layering rule, a setting that must stay
 * wired, a file nothing can reach. None of them is observable by calling the
 * code, and each has been true at some point during the refactor this file
 * exists to keep true.
 *
 * The method matters more than the rules. Every one of these was verified by
 * injecting a real violation and requiring the suite to go red, because a guard
 * that has never failed has not been shown to work — and one of them did not
 * work when first written: the "`lib/` must not import `@/app`" rule matched the
 * specifier `"@/app"` exactly, so it never matched `@/app/actions/x` and passed
 * against a live violation. That is precisely the bug a hand-written tree guard
 * hides, and it is why the verification is not optional.
 *
 * Reading the tree rather than restating a list is the other half: a new
 * violation fails here, which is the only way a boundary survives the next
 * person to add a file.
 */

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");

/** Every `.ts`/`.tsx` under `src`, by absolute path. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const ALL = sourceFiles();
const rel = (file: string) => relative(ROOT, file);

/** The leading `"use client"` / `"use server"` directive, if the file has one. */
function directive(source: string): "use client" | "use server" | null {
  // Only a leading directive counts: the string appears in prose and in tests
  // too, and a mention halfway down a module says nothing about its kind.
  const head = source.slice(0, 400);
  if (/^\s*["']use client["']/m.test(head)) return "use client";
  if (/^\s*["']use server["']/m.test(head)) return "use server";
  return null;
}

// ---------------------------------------------------------------------------
// The layer boundary between lib/ and app/ (Task 17, ADR-004)
// ---------------------------------------------------------------------------

/**
 * Every named import from a module specifier *prefix*, with the local names.
 *
 * Prefix rather than exact match on purpose: the rule it serves is "`lib/` does
 * not import `@/app/...`", and an exact match against `"@/app"` finds nothing,
 * because no file imports the bare directory — they import `@/app/actions/x`.
 * That version of this rule passed against a real violation.
 */
function importsFrom(source: string, prefix: string): string[] {
  const names: string[] = [];
  const re = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](${prefix.replace(
      /[.*+?^${}()|[\]\\]/g,
      String.raw`\$&`,
    )}[^"']*)["']`,
    "g",
  );
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Form and result states: the one shape a `"use server"` module may declare.
 *
 * Each is `useActionState`'s type parameter for a specific action — the value a
 * form holds while its action runs, and the action's own return type. They
 * describe the action's *contract with its form*, which is the one thing a
 * `"use server"` module legitimately describes, and no service returns them.
 * Moving one would mean inventing a module that owns a type nothing produces.
 */
const ACTION_RESULT_SHAPES = new Set([
  "AccountActionState",
  "ActionState",
  "AuthFormState",
  "AiProviderFormState",
  "DecideApprovalState",
  "GoalActionState",
  "PostFormState",
  "PublishActionState",
  "PublishDueResult",
  "SettingsFormState",
  "TelegramConnectResult",
]);

/**
 * `PreferencesInput` is the one exception that is not a form state, and it is
 * here rather than in `src/lib` only because nothing renders it: it is the
 * validated shape of a `user_preferences` upsert, and the UI toggles that would
 * have consumed it were removed in Task 14 (a toggle that changes nothing is a
 * false claim). If they are reintroduced, this belongs in the service beside the
 * columns it describes.
 */
const ACTION_OWNED_INPUT_SHAPES = new Set(["PreferencesInput"]);

describe("lib/ does not depend on app/", () => {
  it("has no import from @/app in any module under src/lib", () => {
    const violations = ALL.filter((file) => file.startsWith(join(SRC, "lib"))).flatMap(
      (file) =>
        importsFrom(readFileSync(file, "utf8"), "@/app").map(
          (name) => `${rel(file)} imports ${name} from @/app/...`,
        ),
    );

    expect(
      violations,
      `src/lib must not reach into src/app — the dependency runs app → lib only.\n` +
        `A lib module importing a "use server" module compiles fine and works fine, ` +
        `which is why it needs a guard rather than a comment.\n\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe('a "use server" module declares no DTOs', () => {
  it("exports only async functions, apart from named form and result states", () => {
    const violations = ALL.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (directive(source) !== "use server") return [];

      return [...source.matchAll(/^export\s+(?:declare\s+)?(interface|type|const|class)\s+(\w+)/gm)]
        .filter((m) => !ACTION_RESULT_SHAPES.has(m[2]) && !ACTION_OWNED_INPUT_SHAPES.has(m[2]))
        .map(
          (m) =>
            `${rel(file)} exports ${m[1]} ${m[2]} — a "use server" module's exports ` +
            `are RPC endpoints, so declare this beside its data in src/lib and ` +
            `re-export the type here.`,
        );
    });

    expect(
      violations,
      `Move these DTOs to the service that owns the data and re-export the type from ` +
        `the action, so a client component depends on the shape rather than on the ` +
        `transport layer.\n\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("a client component takes its DTOs from the service", () => {
  it("imports no type from @/app/actions", () => {
    const violations = ALL.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (directive(source) !== "use client") return [];

      return [...source.matchAll(/import\s+type\s+\{([^}]*)\}\s*from\s*["']@\/app\/actions\/[^"']+["']/g)].flatMap((m) =>
        m[1]
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .map(
            (name) =>
              `${rel(file)} imports type ${name} from @/app/actions/... — calling an ` +
              `action from a client is correct, but a *shape* should come from the module ` +
              `that owns the data.`,
          ),
      );
    });

    expect(
      violations,
      `These are type-only imports, so they cost nothing at runtime and everything in ` +
        `readability: the client now names a transport module to describe a row.\n\n` +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("finds client components and action modules to check", () => {
    // Without this the rules above pass vacuously if a future refactor changes
    // how these files are written — a parser that stops matching anything
    // reports "no violations", which is indistinguishable from clean.
    const clients = ALL.filter((f) => directive(readFileSync(f, "utf8")) === "use client");
    const servers = ALL.filter((f) => directive(readFileSync(f, "utf8")) === "use server");

    expect(clients.length).toBeGreaterThan(20);
    expect(servers.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Reduced motion (Task 18)
// ---------------------------------------------------------------------------

/**
 * Twenty-six components animate through framer-motion, and before
 * `MotionConfig reducedMotion="user"` was set in the root provider, the only
 * reduced-motion handling in the product was a single CSS rule for the docs page
 * fade. A visitor whose operating system asks for reduced motion — set by
 * someone who gets motion sick, dizzy, or triggers migraine from large movement
 * — was still served every JS-driven animation.
 *
 * The fix is one line, which is exactly why it needs a guard: nothing else in
 * the suite, the build, or the linter would notice its removal. This is the cheap
 * static half of the plan's browser-a11y-smoke criterion; it cannot tell
 * whether an animation actually *respects* the setting at runtime, only that the
 * setting is wired up in one place every component is under.
 */
describe("reduced motion is honoured", () => {
  const provider = readFileSync(join(SRC, "components/theme-provider.tsx"), "utf8");

  it("sets framer-motion's reducedMotion from the visitor's system setting", () => {
    expect(provider).toMatch(/<MotionConfig\s+reducedMotion="user"/);
  });

  it("wraps the whole tree, rather than one screen", () => {
    // `MotionConfig` only affects components rendered *inside* it, so a copy
    // pasted into a single page would leave the other twenty-five animating.
    expect(provider).toMatch(
      /NextThemesProvider[\s\S]*<MotionConfig[\s\S]*\{children\}[\s\S]*<\/MotionConfig>/,
    );
  });

  it("is mounted above every route by the root layout", () => {
    const layout = readFileSync(join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<ThemeProvider>\{children\}<\/ThemeProvider>/);
  });
});

// ---------------------------------------------------------------------------
// Reachability (Task 15)
// ---------------------------------------------------------------------------

/**
 * No module is unreachable.
 *
 * The 2026-09-30 sweep found six production modules with no importer, by
 * resolving the real import graph rather than grepping: two orphaned dashboard
 * client files behind a route that permanently redirects, three action modules
 * whose last caller had moved, and a generic-credential UI superseded by the
 * per-platform one. All were deleted. Five more were found and are deliberately
 * **kept** — see the allowlist below.
 *
 * The guard exists because a refactor moves call sites, and what it leaves
 * behind is invisible: the module still compiles, still lints, and still passes
 * typecheck. Nothing in the toolchain objects to a file nobody imports.
 *
 * **The graph is resolved, not grepped.** An earlier attempt matched import
 * specifiers as text and reported `lib/crypto.ts` and `lib/session.ts` as
 * unreferenced — both imported dozens of times — because it did not resolve
 * relative paths or the `@/` alias.
 */
describe("no production module is unreachable", () => {
  /**
   * Modules kept despite having no importer, each with the reason.
   *
   * Keys are repo-relative paths with a `src/` prefix, matching what `rel()`
   * returns — the same form the failure message prints, so a module can be
   * copied straight from the error into this list.
   *
   * This is a decision list, not a backlog. An entry here is a claim that the
   * module is worth its maintenance cost, and it should be revisited — but
   * removing the entry is a deliberate act, not something a refactor should do
   * by accident.
   */
  const KEPT = new Map([
    [
      "src/components/ui/separator.tsx",
      "Radix primitive in the ui/ kit. The kit is a set, not a set of usages: a " +
        "screen that needs a separator should import one rather than reimplement " +
        "the focus and ARIA handling.",
    ],
    [
      "src/components/ui/tabs.tsx",
      "Same: a Radix primitive in the ui/ kit, unused since the Phase 7 UI " +
        "rewrite. Reintroduction is a two-line import.",
    ],
    [
      "src/components/motion/sparkles.tsx",
      "Unused since v0.1.0. A self-contained decorative sparkle overlay.",
    ],
    [
      "src/components/motion/perspective-card.tsx",
      "Unused since v0.1.0. A self-contained 3D tilt wrapper, kept alongside the " +
        "other motion primitives rather than pruned piecemeal — the kit should " +
        "shrink as a decision, not one file at a time.",
    ],
    [
      "src/components/motion/animated-counter.tsx",
      "Unused since v0.1.0. Same reasoning as the other motion primitives.",
    ],
  ]);

  it("finds every production module", () => {
    // Same vacuity guard as above: if the scan silently stops matching, the test
    // below would pass by finding nothing.
    const modules = ALL.filter((f) => !f.endsWith(".test.ts"));
    expect(modules.length).toBeGreaterThan(150);
  });

  it("reports no module with neither an importer nor a framework entry point", () => {
    const files = ALL;
    const present = new Set(files);

    /** Resolve an import specifier to a file in `src/`, or null. */
    const resolveSpecifier = (spec: string, importer: string): string | null => {
      const dir = dirname(importer);
      let base: string;
      if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
      else if (spec.startsWith(".")) base = join(dir, spec);
      else return null;

      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ]) {
        if (present.has(candidate)) return candidate;
      }
      return null;
    };

    // A module is an entry point if the framework may load it by convention
    // rather than by import: a route, a layout, an error boundary, the proxy,
    // or a test.
    const isEntry = (f: string) => {
      const name = basename(f);
      if (name.endsWith(".test.ts")) return true;
      if (f === join(SRC, "proxy.ts")) return true;
      if (name === "middleware.ts" || name === "instrumentation.ts") return true;
      return [
        "page.tsx",
        "layout.tsx",
        "route.ts",
        "error.tsx",
        "global-error.tsx",
        "loading.tsx",
        "not-found.tsx",
        "template.tsx",
        "default.tsx",
      ].includes(name);
    };

    const imported = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const target = resolveSpecifier(m[1], file);
        if (target) imported.add(target);
      }
    }

    const unreachable = files
      .filter((f) => !f.endsWith(".test.ts") && !isEntry(f) && !imported.has(f))
      .map((f) => rel(f))
      .filter((f) => !KEPT.has(f.replace(/\\/g, "/")));

    expect(
      unreachable,
      `These modules have no importer and are not framework entry points, so nothing ` +
        `can reach them. They still compile and still lint, which is why they need a ` +
        `guard.\n\nIf one is deliberately kept, add it to KEPT in this file with the ` +
        `reason it is worth its maintenance cost — that is a decision to be recorded, ` +
        `not one to be made by accident.\n\n${unreachable.join("\n")}`,
    ).toEqual([]);
  });
});
