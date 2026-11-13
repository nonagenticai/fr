#!/usr/bin/env node
/**
 * codemod-info-tokens.mjs
 *
 * Maps the residual semantic-color violations after the Phase 6 gray
 * codemod onto the design-token system:
 *   - purple-*  → --color-info family
 *   - fuchsia-* → --color-info-strong family
 *   - red-950   → --color-danger-bg-deep (andon emphasized alerts)
 *   - amber-950 → --color-warning-bg-deep
 *
 * Mirrors codemod-gray-to-tokens.mjs structure; operates only on class
 * attribute lines; preserves variant prefixes (hover:/dark:/focus:/...).
 *
 * Usage:
 *   node frontend/scripts/codemod-info-tokens.mjs
 *   node frontend/scripts/codemod-info-tokens.mjs --dry-run
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, "..");
const SRC_ROOT = join(FRONTEND_ROOT, "src");
const DRY_RUN = process.argv.includes("--dry-run");

const MAP = {
  bg: {
    "purple-50": "var(--color-info-bg)",
    "purple-100": "var(--color-info-bg)",
    "purple-500": "var(--color-info)",
    "purple-600": "var(--color-info)",
    "purple-700": "var(--color-info-strong)",
    "purple-900": "var(--color-info-bg)",
    "fuchsia-50": "var(--color-info-bg-strong)",
    "red-950": "var(--color-danger-bg-deep)",
    "amber-950": "var(--color-warning-bg-deep)",
  },
  text: {
    "purple-300": "var(--color-info-text)",
    "purple-500": "var(--color-info)",
    "purple-600": "var(--color-info)",
    "purple-700": "var(--color-info-text)",
    "purple-800": "var(--color-info-text)",
    "purple-900": "var(--color-info-text)",
    "fuchsia-700": "var(--color-info-text-strong)",
  },
  border: {
    "purple-200": "var(--color-info-border)",
    "purple-300": "var(--color-info-border)",
    "fuchsia-200": "var(--color-info-border-strong)",
  },
  from: {
    "purple-100": "var(--color-info-bg)",
    "blue-100": "var(--color-accent)",
    "green-100": "var(--color-success)",
  },
  to: {
    "purple-100": "var(--color-info-bg)",
    "pink-100": "var(--color-info-bg-strong)",
    "teal-100": "var(--color-accent)",
  },
};

const VARIANTS = [
  "hover", "focus", "active", "dark", "disabled",
  "group-hover", "peer-hover", "focus-visible", "focus-within",
];

function buildRegex(propertyPrefix, mapping) {
  const variantAlt = VARIANTS.map((v) => v.replace("-", "\\-")).join("|");
  const valueAlt = Object.keys(mapping)
    .sort((a, b) => b.length - a.length)
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
    { regex: buildRegex(prefix, mapping), mapping, prefix },
  ]),
);

function lineMayBeClass(line) {
  return (
    line.includes("class=") ||
    line.includes("class:") ||
    line.includes(":class=") ||
    line.includes("cls:") ||
    line.includes("classList") ||
    /\bcls\s*:\s*['"`]/.test(line)
  );
}

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
    for (const [, { regex, mapping, prefix }] of Object.entries(REGEX_TABLE)) {
      out = out.replace(regex, (_match, variantPrefix, value) => {
        const replacement = mapping[value];
        if (!replacement) return _match;
        fileReplacements++;
        return `${variantPrefix || ""}${prefix}-[${replacement}]`;
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
console.log("Files touched:");
for (const [p, c] of perFileCounts) {
  console.log(`  ${c.toString().padStart(4)}  ${p.replace(FRONTEND_ROOT + "/", "")}`);
}
