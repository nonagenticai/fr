/**
 * ⛔ THE ANTI-FAKE-PROGRESS PATTERN, AND WHY IT IS BOUNDED THIS WAY.
 *
 * The naive form `/\d+\s*(of|\/)\s*\d+/` is WRONG and it failed only in CI. A
 * milestone date rendered by `toLocaleDateString()` under CI's en-US locale is
 * `10/1/2026`, whose leading `10/1` matches that pattern — so the assertion fired
 * on a DATE, passed on a developer box with no `LANG` set, and reddened where it is
 * graded. Reproduced byte-for-byte with `TZ=UTC LANG=en_US.UTF-8`.
 *
 * Two properties are therefore required, and both are pinned by the controls below:
 *   1. it must NOT match any locale's date or time rendering, and
 *   2. it MUST still match a real progress fraction.
 * The denominator is capped at 3 digits and may not be followed by a digit, `/`,
 * `.` or `-`, which is what excludes a 4-digit year and a d/m/yyyy tail.
 */
export const PROGRESS_FRACTION = /\b\d{1,3}\s*(?:of|\/)\s*\d{1,3}\b(?![\d/.\-])/;
