import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The gold accent scale must be able to carry readable text.
 *
 * ## Why this is a test and not a lint rule
 *
 * Every contrast failure in this codebase so far was the same mistake: a colour
 * pair picked by eye. `text-gold-600 dark:text-gold-400` looked like "darker in
 * light, lighter in dark" and measured 3.29:1 in one theme and 3.72:1 in the other.
 * Both halves were wrong, and `jsx-a11y` cannot see colour at all.
 *
 * The accessibility smoke test catches these in the *rendered* page, but only for
 * the pages it visits and the states it happens to reach. This checks the
 * palette itself, so a new pair chosen from these tokens fails immediately,
 * before any page renders.
 *
 * ## Why the dark palette is the awkward one
 *
 * The two palettes invert. In light mode the scale runs light → dark, so white
 * text needs a *dark* step. In dark mode the same step numbers are dark → light,
 * so the steps that take white text are the low numbers, and the bright ones
 * need dark text. A pair that works in one theme very often fails in the other.
 *
 * `defaultTheme="dark"`, so dark is the case that matters most.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const AA_TEXT = 4.5;

type GoldScale = Record<string, string>;

/** The palettes, mirroring `src/app/globals.css`. Asserted against it below. */
const LIGHT: { bg: string; card: string; gold: GoldScale; foreground: string } = {
  bg: "#fafaf7",
  card: "#ffffff",
  gold: {
    "400": "#f3b94a",
    "500": "#da9a2e",
    "600": "#b87f24",
    "700": "#91651c",
    "800": "#6e4d17",
    "900": "#4a3610",
  },
  foreground: "#1c1a16",
};

const DARK: { bg: string; card: string; gold: GoldScale; foreground: string } = {
  bg: "#0d0b08",
  card: "#15120c",
  gold: {
    "300": "#5e4a22",
    "400": "#8a6a2e",
    "500": "#b88f3a",
    "600": "#da9a2e",
    "700": "#e5b94a",
    "800": "#f0c96a",
    "900": "#fce9a8",
  },
  foreground: "#f3efe3",
};

describe("the gold scale can carry text", () => {
  it("matches globals.css, so this test cannot drift from the real palette", async () => {
    const css = readFileSync("src/app/globals.css", "utf8");

    for (const [theme, palette] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      for (const [step, hex] of Object.entries(palette.gold)) {
        // The dark values live in the `.dark` block, light in `:root`; both are
        // matched wherever they appear, since the two blocks contain the same
        // step names with different values.
        expect(
          css.includes(`--gold-${step}: ${hex};`),
          `${theme} --gold-${step} is ${hex} in this test but not in globals.css. ` +
            `Update the copy here when the palette changes, or this test stops ` +
            `describing the colours the app actually renders.`,
        ).toBe(true);
      }
    }
  });

  it("names the light steps that work with white text", () => {
    const usable = Object.entries(LIGHT.gold)
      .filter(([, hex]) => contrast(hex, "#ffffff") >= AA_TEXT)
      .map(([step]) => step);
    // 700 and deeper. Anything from 400–600 is decorative-only.
    expect(usable).toEqual(["700", "800", "900"]);
  });

  it("names the dark steps that work as text on the card background", () => {
    const usable = Object.entries(DARK.gold)
      .filter(([, hex]) => contrast(hex, DARK.card) >= AA_TEXT)
      .map(([step]) => step);
    // In dark mode the bright end carries text, which is the opposite of light
    // mode — the inversion is why a pair chosen in one theme fails in the other.
    expect(usable).toEqual(["500", "600", "700", "800", "900"]);
  });

  it("every gold text pair in the tree clears AA on the page background", async () => {
    // Scan all of `src/` rather than an allowlist of files.
    //
    // The first version listed four targets and read their class strings. That
    // works until someone adds a gold link to a fifth page — which is exactly
    // what happened: fixing login revealed the same inverted pair on /privacy and
    // in the app shell. So this walks every `.tsx` and checks every
    // `text-gold-N … dark:text-gold-M` pair it finds.
    //
    // Assumed background is the *page* background in both themes, which is the
    // conservative choice: most gold text sits on the page, and a pair that only
    // clears on a card is legitimate but rare enough that the few exceptions are
    // listed explicitly rather than assumed.
    const { readdirSync, statSync, readFileSync } = await import("node:fs");
    const { join, relative } = await import("node:path");

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith(".tsx")) out.push(full);
      }
      return out;
    };

    // Pairs known to sit on a surface other than the page, in *both* themes.
    //
    // The dashboard rail and the signed-in user chip are dark regardless of the
    // theme — they are inside the app shell, not the marketing pages — so the
    // steps that read there are the ones that clear against a dark background,
    // which is the opposite of the page. Listing them here is the point: adding a
    // surface is a decision with a name attached, not a silent exception.
    const ON_DARK_SURFACE: Record<string, string> = {
      "src/components/sidebar.tsx": DARK.bg,
      "src/components/app-shell.tsx": DARK.card,
    };

    // Surfaces that are a card rather than the page. In light mode a card is
    // white, in dark mode it is the raised panel colour — so only the dark half
    // changes, which is the opposite of a dark surface in both themes.
    const ON_CARD: Record<string, string> = {
      "src/app/(auth)/login/page.tsx": DARK.card,
      "src/app/(auth)/signup/page.tsx": DARK.card,
      "src/app/docs/layout.tsx": DARK.card,
    };

    const failures: string[] = [];

    for (const file of walk("src")) {
      const source = readFileSync(file, "utf8");
      const rel = relative(".", file).replace(/\\/g, "/");
      const darkBg = ON_DARK_SURFACE[rel] ?? ON_CARD[rel] ?? DARK.bg;

      for (const m of source.matchAll(
        /"([^"]*\btext-gold-(\d{3})\b[^"]*\bdark:text-gold-(\d{3})\b[^"]*)"/g,
      )) {
        const lightStep = m[2] ?? "";
        const darkStep = m[3] ?? "";

        // A dark surface in both themes means the light-mode step is judged
        // against that same dark surface, not against the light page.
        const lightBg = ON_DARK_SURFACE[rel] ? darkBg : LIGHT.bg;
        const light = contrast(LIGHT.gold[lightStep], lightBg);
        const dark = contrast(DARK.gold[darkStep], darkBg);

        if (light < AA_TEXT) {
          failures.push(
            `  ${rel}: text-gold-${lightStep} on ${lightBg} = ${light.toFixed(2)}:1`,
          );
        }
        if (dark < AA_TEXT) {
          failures.push(
            `  ${rel}: dark:text-gold-${darkStep} on ${darkBg} = ${dark.toFixed(2)}:1`,
          );
        }
      }
    }

    expect(
      failures,
      `Gold text below WCAG AA (${AA_TEXT}:1). The palettes invert — in light mode the\n` +
        `scale runs light→dark and dark mode runs dark→light, so a pair that reads in\n` +
        `one theme fails in the other. Both halves are checked.\n\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("checks the filled button's *background* against its text", async () => {
    // A different shape from the text-pair check above. The filled `gold` button
    // sets a gold background and a neutral text colour, so the thing that has to
    // clear 4.5:1 is the fill — and the scanner that checks `text-gold-N` pairs
    // never sees it. Verified by mutation: reverting the light fill to gold-600
    // (3.44:1) or the dark fill to gold-500 (2.60:1) both went unnoticed until
    // this test existed, which is the whole reason it is separate rather than
    // folded into the pair list.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/ui/button.tsx", "utf8");
    const gold = source.match(/(?:^|\n)\s*gold:\s*"([^"]+)"/)?.[1] ?? "";

    const lightFill = gold.match(/(?:^|\s)bg-gold-(\d{3})/)?.[1];
    const darkFill = gold.match(/dark:bg-gold-(\d{3})/)?.[1];
    const lightText = gold.match(/(?:^|\s)text-white/)?.[0] ? "#ffffff" : null;
    const darkText = gold.match(/dark:text-foreground/)?.[0] ? DARK.foreground : null;

    const failures: string[] = [];
    if (lightFill && lightText) {
      const r = contrast(LIGHT.gold[lightFill], lightText);
      if (r < AA_TEXT) {
        failures.push(`  light: bg-gold-${lightFill} under ${lightText} = ${r.toFixed(2)}:1`);
      }
    }
    if (darkFill && darkText) {
      const r = contrast(darkText, DARK.gold[darkFill]);
      if (r < AA_TEXT) {
        failures.push(`  dark: ${darkText} on bg-gold-${darkFill} = ${r.toFixed(2)}:1`);
      }
    }

    expect(
      failures,
      `The filled gold button's fill does not carry its own label:\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("reports the dark button ratio with room to spare", () => {
    // 7.37:1 — the gold-300 fill against the neutral foreground. Asserted as a
    // floor rather than an exact value so a small palette tweak does not fail
    // the suite, but a move back to the bright end does.
    expect(contrast(DARK.gold["300"], DARK.foreground)).toBeGreaterThanOrEqual(6);
  });

  it("shows why the old pair failed, in both themes", () => {
    // Regression documentation. If this ever starts passing, someone has changed
    // the palette in a way that makes the old answer recoverable — worth knowing.
    expect(contrast(LIGHT.gold["600"], LIGHT.bg)).toBeLessThan(AA_TEXT);
    expect(contrast(DARK.gold["400"], DARK.card)).toBeLessThan(AA_TEXT);
  });
});