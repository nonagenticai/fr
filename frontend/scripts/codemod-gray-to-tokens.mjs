#!/usr/bin/env node
/**
 * codemod-gray-to-tokens.mjs
 *
 * Mechanical replacement of Tailwind gray palette utilities with
 * design-token CSS variables. Drives the design-tokens lint baseline
 * down by handling the ~66% of violations that are pure gray-scale
 * (`text-gray-500`, `bg-gray-100`, `border-gray-300`, etc.) and their
 * `hover:` / `dark:` / `focus:` variants.
 *
 * The semantic-color subset (red/blue/green/yellow → danger/accent/
 * success/warning) requires per-call human judgement; that's Phase 7.
 *
 * Usage:
 *   node frontend/scripts/codemod-gray-to-tokens.mjs           # apply
 *   node frontend/scripts/codemod-gray-to-tokens.mjs --dry-run  # preview
 *   node frontend/scripts/codemod-gray-to-tokens.mjs --files <glob>
 *
 * Scope:
 *   - Only edits `*.svelte` files under `frontend/src/`.
 *   - Only touches lines containing `class=`, `class:`, `:class=`, or
 *     `cls:` to avoid rewriting arbitrary string literals.
 *   - Preserves variant prefix (e.g. `hover:bg-gray-100` keeps the
 *     `hover:` and just swaps the value).
 *
 * Tokens (defined in src/lib/styles/tokens.css):
 *   --color-bg            = white / very dark
 *   --color-surface       = gray-50/100 in light, gray-800 in dark
 *   --color-surface-strong = gray-200 in light, gray-700 in dark
 *   --color-text          = gray-900 in light, gray-50 in dark
 *   --color-text-muted    = gray-500 in light, gray-400 in dark
 *   --color-border        = gray-200 in light, gray-700 in dark
 *   --color-border-strong = gray-300 in light, gray-600 in dark
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, "..");
const SRC_ROOT = join(FRONTEND_ROOT, "src");
const DRY_RUN = process.argv.includes("--dry-run");

// --- Mapping table --------------------------------------------------------
// For each Tailwind utility-prefix + gray shade, the token replacement.
// 'white' and 'black' are also mapped because they routinely co-occur with
// gray in foreground/background pairs.
const MAP = {
  bg: {
    white: "var(--color-bg)",
    black: "var(--color-bg)",
    "gray-50": "var(--color-surface)",
    "gray-100": "var(--color-surface)",
    "gray-200": "var(--color-surface-strong)",
    "gray-300": "var(--color-surface-strong)",
    "gray-700": "var(--color-surface-strong)",
    "gray-800": "var(--color-surface)",
    "gray-900": "var(--color-bg)",
  },
  text: {
    white: "var(--color-text)",
    black: "var(--color-text)",
    "gray-300": "var(--color-text-muted)",
    "gray-400": "var(--color-text-muted)",
    "gray-500": "var(--color-text-muted)",
    "gray-600": "var(--color-text)",
    "gray-700": "var(--color-text)",
    "gray-800": "var(--color-text)",
    "gray-900": "var(--color-text)",
  },
  border: {
    white: "var(--color-border)",
    "gray-100": "var(--color-border)",
    "gray-200": "var(--color-border)",
    "gray-300": "var(--color-border-strong)",
    "gray-400": "var(--color-border-strong)",
    "gray-600": "var(--color-border-strong)",
    "gray-700": "var(--color-border)",
    "gray-800": "var(--color-border-strong)",
  },
  ring: {
    "gray-200": "var(--color-border)",
    "gray-300": "var(--color-border-strong)",
    "gray-700": "var(--color-border-strong)",
  },
  divide: {
    "gray-100": "var(--color-border)",
    "gray-200": "var(--color-border)",
    "gray-700": "var(--color-border-strong)",
  },
};

// Variant prefixes we accept on the left side of the colon.
const VARIANTS = [
  "hover", "focus", "active", "dark", "disabled",
  "group-hover", "peer-hover", "focus-visible", "focus-within",
];

// Build a single regex per property prefix. The regex captures:
//   group 1: optional variant prefix with trailing colon (e.g. "hover:")
//   group 2: the value (e.g. "gray-100" or "white")
function buildRegex(propertyPrefix, mapping) {
  const variantAlt = VARIANTS.map((v) => v.replace("-", "\\-")).join("|");
  const valueAlt = Object.keys(mapping)
    .sort((a, b) => b.length - a.length) // longer first to avoid prefix-match issues
    .map((k) => k.replace("-", "\\-"))
    .join("|");
  return new RegExp(
    `\\b((?:${variantAlt}):)?${propertyPrefix}\\-(${valueAlt})\\b`,
    "g",
  );
}

const REGEX_TABLE = Object.fromEntries(
  Object.entries(MAP).map(([prefix, mapping]) => [
    prefix,
    { regex: buildRegex(prefix, mapping), mapping },
  ]),
);

// --- Line-level filter ----------------------------------------------------
function lineMayBeClass(line) {
  // Restrict to lines that look like class context. This avoids rewriting
  // a quoted string literal that happens to contain "bg-gray-100".
  return (
    line.includes("class=") ||
    line.includes("class:") ||
    line.includes(":class=") ||
    line.includes("cls:") ||
    line.includes("classList") ||
    // Inside a `cls: '...'` map (common pattern in this repo)
    /\bcls\s*:\s*['"`]/.test(line)
  );
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
    let out = line;
    for (const [, { regex, mapping }] of Object.entries(REGEX_TABLE)) {
      out = out.replace(regex, (_match, variantPrefix, value) => {
        const replacement = mapping[value];
        if (!replacement) return _match;
        fileReplacements++;
        // Wrap with Tailwind arbitrary-value brackets
        return `${variantPrefix || ""}${_match.split("-")[0].replace(variantPrefix || "", "")}-[${replacement}]`;
      });
    }
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
