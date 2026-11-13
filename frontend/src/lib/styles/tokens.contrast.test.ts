// WCAG 2.1 contrast smoke test for design tokens.
//
// Parses tokens.css, extracts :root (light) and .dark (dark) palettes, then
// asserts that every semantic bg/text pair plus solid-fill / on-primary pair
// meets the minimum required contrast ratio.
//
// This guards against regressions of the class we just fixed (e.g. accidentally
// pairing `bg-[var(--color-success)]` with `text-[var(--color-success)]` again).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = readFileSync(join(HERE, 'tokens.css'), 'utf8');

// Extract `--name: #hex;` declarations from a named CSS block.
function parsePalette(blockSelector: string): Record<string, string> {
  const escaped = blockSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`);
  const block = TOKENS_CSS.match(blockRe);
  if (!block) throw new Error(`block not found: ${blockSelector}`);
  const palette: Record<string, string> = {};
  const declRe = /--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(block[1])) !== null) {
    palette[m[1]] = m[2];
  }
  return palette;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) throw new Error(`unsupported hex: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// WCAG 2.1 relative luminance.
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const lf = luminance(fg);
  const lb = luminance(bg);
  const [lighter, darker] = lf > lb ? [lf, lb] : [lb, lf];
  return (lighter + 0.05) / (darker + 0.05);
}

const light = parsePalette(':root');
const dark = parsePalette('.dark');

// Pairs that must clear AA normal-text (4.5:1) — these are the badge/toast
// bg+text combinations we just standardized.
const TEXT_ON_BG_PAIRS: Array<[bgKey: string, textKey: string]> = [
  ['color-success-bg', 'color-success-text'],
  ['color-accent-bg', 'color-accent-text'],
  ['color-warning-bg', 'color-warning-text'],
  ['color-danger-bg', 'color-danger-text'],
  ['color-info-bg', 'color-info-text'],
];

// Pairs that must clear AA UI / large-text (3.0:1) — these are solid-fill
// buttons with their canonical "on-primary" label color.
const UI_FILL_PAIRS: Array<[bgKey: string, textKey: string]> = [
  ['color-accent', 'color-on-primary'],
  ['color-accent-strong', 'color-on-primary'],
  ['color-danger', 'color-on-primary'],
];

describe('design tokens — WCAG contrast', () => {
  for (const mode of ['light', 'dark'] as const) {
    const palette = mode === 'light' ? light : dark;

    describe(mode, () => {
      for (const [bgKey, textKey] of TEXT_ON_BG_PAIRS) {
        it(`${bgKey} + ${textKey} ≥ 4.5:1`, () => {
          const bg = palette[bgKey];
          const fg = palette[textKey];
          expect(bg, `${bgKey} missing`).toBeTruthy();
          expect(fg, `${textKey} missing`).toBeTruthy();
          const ratio = contrast(fg, bg);
          expect(ratio, `actual ${ratio.toFixed(2)}:1 (${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
        });
      }

      for (const [bgKey, textKey] of UI_FILL_PAIRS) {
        it(`${bgKey} + ${textKey} ≥ 3.0:1`, () => {
          const bg = palette[bgKey];
          const fg = palette[textKey];
          expect(bg, `${bgKey} missing`).toBeTruthy();
          expect(fg, `${textKey} missing`).toBeTruthy();
          const ratio = contrast(fg, bg);
          expect(ratio, `actual ${ratio.toFixed(2)}:1 (${fg} on ${bg})`).toBeGreaterThanOrEqual(3.0);
        });
      }
    });
  }
});
