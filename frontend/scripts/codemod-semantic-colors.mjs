#!/usr/bin/env node
/**
 * codemod-semantic-colors.mjs
 *
 * Sibling of codemod-gray-to-tokens.mjs. Handles the semantic-color
 * subset (Phase 7): red/blue/green/yellow/amber/orange/sky/indigo Tailwind
 * utility classes → design-token CSS variables.
 *
 * Mapping strategy:
 *   red    → danger     (has -bg / -border / -text variants)
 *   yellow → warning    (has -bg / -border / -text variants)
 *   amber  → warning    (alias of yellow in this codebase)
 *   orange → warning    (closest existing semantic match)
 *   blue   → accent     (single token, no -bg/-border/-text variants)
 *   sky    → accent     (alias of blue)
 *   indigo → accent     (alias of blue)
 *   green  → success    (single token, no -bg/-border/-text variants)
 *   emerald → success
 *
 * Where the source palette has multiple shades but only a single token
 * (blue, green), the codemod collapses all shades to the single token.
 * The semantic intent — "this is success/accent/etc." — is what matters;
 * exact hue is theme-handled via the var indirection.
 *
 * Where the source palette has -bg/-border/-text variants (red, yellow,
 * amber, orange), shades map as:
 *   50/100/200      → -bg
 *   300/400         → -border
 *   500/600/700/800/900 → main token (color: text) or token itself (background)
 *
 * Variant prefixes (hover:, dark:, focus:, disabled:, group-hover:, etc.)
 * are preserved.
 *
 * Usage:
 *   node frontend/scripts/codemod-semantic-colors.mjs           # apply
 *   node frontend/scripts/codemod-semantic-colors.mjs --dry-run  # preview
 *
 * Tokens (in src/lib/styles/tokens.css):
 *   --color-accent / --color-accent-strong
 *   --color-success
 *   --color-warning / --color-warning-bg / --color-warning-border / --color-warning-text
 *   --color-danger  / --color-danger-bg  / --color-danger-border  / --color-danger-text
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, "..");
const SRC_ROOT = join(FRONTEND_ROOT, "src");
const DRY_RUN = process.argv.includes("--dry-run");

// --- Shade → semantic-role mapping ---------------------------------------
// Each hue family maps shade strings to which token variant to use.
// For families with no semantic variants (blue/green), all shades use the
// base token regardless.
const RED_SHADES = {
  // backgrounds — pale
  "50": "danger-bg",
  "100": "danger-bg",
  "200": "danger-bg",
  // borders — mid-pale
  "300": "danger-border",
  "400": "danger-border",
  // foreground / strong fills
  "500": "danger",
  "600": "danger",
  "700": "danger",
  "800": "danger-text",
  "900": "danger-bg", // dark-mode bg fallback; var swaps in dark theme
};
const YELLOW_SHADES = {
  "50": "warning-bg",
  "100": "warning-bg",
  "200": "warning-bg",
  "300": "warning-border",
  "400": "warning-border",
  "500": "warning",
  "600": "warning",
  "700": "warning",
  "800": "warning-text",
  "900": "warning-bg",
};
const BLUE_SHADES = {
  // No -bg/-border/-text variants for accent. Collapse to the single token,
  // with -strong for darker/hover variants.
  "50": "accent",
  "100": "accent",
  "200": "accent",
  "300": "accent",
  "400": "accent",
  "500": "accent",
  "600": "accent",
  "700": "accent-strong",
  "800": "accent-strong",
  "900": "accent-strong",
};
const GREEN_SHADES = {
  // No -bg/-border/-text variants for success. Single token.
  "50": "success",
  "100": "success",
  "200": "success",
  "300": "success",
  "400": "success",
  "500": "success",
  "600": "success",
  "700": "success",
  "800": "success",
  "900": "success",
};

// Gray-family shades mapped to gray-tokens per property (gray-bg/-text/-border).
// Mirrors codemod-gray-to-tokens.mjs but uses per-property mapping (since gray
// targets different tokens for bg vs text vs border vs ring).
//
// These hues all map to the gray family in the design system: slate, zinc,
// neutral, stone are visually gray-equivalent; the codebase mixes them
// interchangeably with gray.
const GRAY_BG = {
  "50": "surface",
  "100": "surface",
  "200": "surface-strong",
  "300": "surface-strong",
  "400": "surface-strong",
  "500": "surface-strong",
  "600": "surface-strong",
  "700": "surface-strong",
  "800": "surface",
  "900": "bg",
};
const GRAY_TEXT = {
  "50": "text",
  "100": "text",
  "200": "text-muted",
  "300": "text-muted",
  "400": "text-muted",
  "500": "text-muted",
  "600": "text",
  "700": "text",
  "800": "text",
  "900": "text",
};
const GRAY_BORDER = {
  "50": "border",
  "100": "border",
  "200": "border",
  "300": "border-strong",
  "400": "border-strong",
  "500": "border-strong",
  "600": "border-strong",
  "700": "border",
  "800": "border-strong",
  "900": "border-strong",
};
// Gray hue handler — chooses table by utility prefix.
function grayRole(utility, shade) {
  if (utility === "bg") return GRAY_BG[shade];
  if (utility === "text") return GRAY_TEXT[shade];
  if (utility === "border" || utility === "ring" || utility === "divide") return GRAY_BORDER[shade];
  return undefined;
}

// Hue alias → canonical shade table.
//   Semantic hues use a per-shade lookup (RED_SHADES style).
//   Gray-family hues use the special `__gray__` marker → triggers grayRole().
const HUE_TABLE = {
  red: RED_SHADES,
  rose: RED_SHADES,
  pink: RED_SHADES,
  yellow: YELLOW_SHADES,
  amber: YELLOW_SHADES,
  orange: YELLOW_SHADES,
  blue: BLUE_SHADES,
  sky: BLUE_SHADES,
  indigo: BLUE_SHADES,
  cyan: BLUE_SHADES,
  green: GREEN_SHADES,
  emerald: GREEN_SHADES,
  teal: GREEN_SHADES,
  lime: GREEN_SHADES,
  // Gray-family — handled specially by grayRole()
  gray: "__gray__",
  slate: "__gray__",
  zinc: "__gray__",
  neutral: "__gray__",
  stone: "__gray__",
};

// Utility prefixes we rewrite.
const UTILITY_PREFIXES = ["bg", "text", "border", "ring", "divide"];

// Variant prefixes accepted on the left side of the colon.
const VARIANTS = [
  "hover", "focus", "active", "dark", "disabled",
  "group-hover", "peer-hover", "focus-visible", "focus-within",
];

const hueAlt = Object.keys(HUE_TABLE).join("|");
const variantAlt = VARIANTS.map((v) => v.replace("-", "\\-")).join("|");
const utilAlt = UTILITY_PREFIXES.join("|");

// Master regex: captures variant?, utility prefix, hue, shade
//   group 1: optional variant prefix incl. colon (e.g. "hover:")
//   group 2: utility prefix (bg/text/border/ring/divide)
//   group 3: hue family (red/yellow/blue/green/etc.)
//   group 4: shade number (50/100/.../900)
const MASTER_REGEX = new RegExp(
  `\\b((?:${variantAlt}):)?(${utilAlt})\\-(${hueAlt})\\-([0-9]{2,3})\\b`,
  "g",
);

// --- Line-level filter ----------------------------------------------------
// Heuristic: a line is likely a class context if any of:
//   1. it contains class=/class:/:class=/cls:/classList,
//   2. or it returns/assigns/contains a quoted string of tailwind tokens
//      (e.g. `return 'bg-red-100 text-red-800'`, common in helper switches
//      that compute class strings outside JSX/Svelte attributes).
//
// The MASTER_REGEX itself only matches `[bg|text|border|ring|divide]-<hue>-<shade>`
// which is precise enough that false positives in arbitrary strings are
// negligible; but we still gate by line for safety.
function lineMayBeClass(line) {
  if (
    line.includes("class=") ||
    line.includes("class:") ||
    line.includes(":class=") ||
    line.includes("cls:") ||
    line.includes("classList") ||
    /\bcls\s*:\s*['"`]/.test(line)
  ) return true;
  // String literal containing 2+ tailwind class-like tokens — covers
  // `return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'`
  return /['"`][^'"`]*\b(?:bg|text|border|ring|divide)-\w+-\d{2,3}\b[^'"`]*['"`]/.test(line);
}

// --- Rewrite ---------------------------------------------------------------
function resolveRole(hue, utility, shade) {
  const entry = HUE_TABLE[hue];
  if (!entry) return undefined;
  if (entry === "__gray__") return grayRole(utility, shade);
  return entry[shade];
}

function rewriteLine(line) {
  return line.replace(MASTER_REGEX, (match, variantPrefix, utility, hue, shade) => {
    const role = resolveRole(hue, utility, shade);
    if (!role) return match;
    return `${variantPrefix || ""}${utility}-[var(--color-${role})]`;
  });
}

// --- File walk ------------------------------------------------------------
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".svelte")) {
      yield full;
    }
  }
}

// --- Apply codemod --------------------------------------------------------
let filesChanged = 0;
let totalReplacements = 0;
const perFileCounts = [];

for (const path of walk(SRC_ROOT)) {
  const original = readFileSync(path, "utf-8");
  const lines = original.split("\n");
  let fileReplacements = 0;
  const newLines = lines.map((line) => {
    if (!lineMayBeClass(line)) return line;
    let count = 0;
    const out = line.replace(MASTER_REGEX, (match, variantPrefix, utility, hue, shade) => {
      const role = resolveRole(hue, utility, shade);
      if (!role) return match;
      count++;
      return `${variantPrefix || ""}${utility}-[var(--color-${role})]`;
    });
    if (count > 0) fileReplacements += count;
    return out;
  });
  if (fileReplacements > 0) {
    filesChanged++;
    totalReplacements += fileReplacements;
    perFileCounts.push([path, fileReplacements]);
    if (!DRY_RUN) writeFileSync(path, newLines.join("\n"), "utf-8");
  }
}

perFileCounts.sort((a, b) => b[1] - a[1]);
const heading = DRY_RUN ? "DRY-RUN — no files written" : "Applied";
console.log(`\n${heading}`);
console.log(`Files changed: ${filesChanged}`);
console.log(`Total replacements: ${totalReplacements}\n`);
console.log("Top 20 files by replacement count:");
for (const [p, c] of perFileCounts.slice(0, 20)) {
  console.log(`  ${c.toString().padStart(4)}  ${p.replace(FRONTEND_ROOT + "/", "")}`);
}
