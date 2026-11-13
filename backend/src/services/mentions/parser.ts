// src/services/mentions/parser.ts
/**
 * Extract `@handle` tokens from plain text.
 *
 * Skips:
 *   - fenced code blocks (```...```)
 *   - inline code (`...`)
 *   - email-shaped `@`s (i.e. preceded by an alphanumeric / `._+-` char)
 *
 * Returns a deduplicated array in first-seen order.
 */
export function parseMentions(text: string): string[] {
  // Strip code blocks and inline code first so mentions inside them are ignored.
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');

  // `(?:^|[^A-Za-z0-9_.+-])` — must start-of-string or non-identifier char
  //                           (rules out email-shaped `alice@example.com`).
  // `@([A-Za-z0-9_][A-Za-z0-9_.-]{0,62})` — handle is 1-63 chars, leads with
  //                           alphanumeric/underscore.
  // `(?![A-Za-z0-9_.+-])`   — must not be followed by identifier/email chars
  //                           (rules out `@bob.com`, `@bob+tag`).
  const pattern = /(?:^|[^A-Za-z0-9_.+-])@([A-Za-z0-9_][A-Za-z0-9_.-]{0,62})(?![A-Za-z0-9_.+-])/g;

  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(stripped)) !== null) {
    const handle = m[1]!;
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}
