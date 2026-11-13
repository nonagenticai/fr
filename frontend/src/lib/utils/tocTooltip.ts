import { escapeHtml } from './escapeHtml';

// Shared tooltip markup for the TOC reasoning graphs (IOMapTree, CRTTree). The
// node `title` and `statement` are free-text LTP content authored by users / the
// AA-LLM pipeline, so every interpolated field MUST be HTML-escaped before it is
// assigned to `tooltipEl.innerHTML` — otherwise a node titled `<img src=x
// onerror=…>` executes in a co-tenant reviewer's browser (stored XSS).
export function buildTocTooltipHtml(n: {
  title?: string | null;
  node_kind?: string | null;
  statement?: string | null;
}): string {
  return (
    `<div class="font-semibold text-sm">${escapeHtml(n.title)}</div>` +
    `<div class="text-xs text-[var(--color-text-muted)] mt-1">${escapeHtml(n.node_kind)}</div>` +
    `<div class="text-xs text-[var(--color-text-muted)] mt-1 max-w-xs">${escapeHtml(n.statement ?? '')}</div>`
  );
}
