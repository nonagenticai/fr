/**
 * Client-side export of the current graph view. No backend, no data mutation —
 * just serialise what's already on screen.
 *
 *   · exportJSON — the working {nodes, relationships} set as a .json download.
 *   · exportPNG  — a raster of the live <svg>. CSS custom-property fills
 *                  (var(--color-*)) don't survive SVG→canvas serialisation, so
 *                  computed fill/stroke are inlined onto a clone first.
 */

import type { KagRecord } from '$lib/api/kag';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportJSON(
  data: { nodes: KagRecord[]; relationships: KagRecord[] },
  filename = 'kag-graph.json',
) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

// The visual properties that must be inlined for a faithful raster.
const INLINE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'opacity', 'font-size', 'font-weight'];

function inlineComputedStyles(src: SVGSVGElement, clone: SVGSVGElement) {
  const srcEls = [src, ...Array.from(src.querySelectorAll<SVGElement>('*'))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
  for (let i = 0; i < srcEls.length && i < cloneEls.length; i++) {
    const cs = getComputedStyle(srcEls[i]!);
    for (const prop of INLINE_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (val && val !== 'none') cloneEls[i]!.setAttribute(prop, val);
    }
  }
}

/**
 * Rasterise the given <svg> to a PNG download. Best-effort — resolves throwing
 * to a rejected promise so the caller can surface a message. `bgColor` paints a
 * solid backdrop (SVGs are transparent) so the export reads on any viewer.
 */
export function exportPNG(
  svg: SVGSVGElement,
  filename = 'kag-graph.png',
  bgColor?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const vb = svg.viewBox.baseVal;
      const width = vb && vb.width ? vb.width : svg.clientWidth || 800;
      const height = vb && vb.height ? vb.height : svg.clientHeight || 560;

      const clone = svg.cloneNode(true) as SVGSVGElement;
      inlineComputedStyles(svg, clone);
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

      const xml = new XMLSerializer().serializeToString(clone);
      const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));

      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Canvas 2D context unavailable.'));
          const bg =
            bgColor ?? getComputedStyle(svg).backgroundColor ?? '';
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (!blob) return reject(new Error('PNG encoding failed.'));
            triggerDownload(blob, filename);
            resolve();
          }, 'image/png');
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('Could not rasterise the graph.'));
      img.src = svg64;
    } catch (e) {
      reject(e);
    }
  });
}
