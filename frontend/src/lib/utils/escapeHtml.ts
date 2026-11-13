// Escape a plain-text string for safe interpolation into an HTML string that
// will be assigned to `innerHTML` / rendered via `{@html}`. Use this whenever a
// value that is NOT meant to be HTML (entity titles, statements, labels, metric
// keys, etc.) is concatenated into markup — otherwise user/LLM-authored content
// becomes a stored-XSS sink (e.g. a requirement titled `<img src=x onerror=…>`).
//
// This escapes the five HTML-significant characters. It does NOT sanitize HTML
// that is *intended* to be rich markup — for that, render the value as text or
// pass it through a real sanitizer.
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string,
  );
}
