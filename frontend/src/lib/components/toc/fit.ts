// Fit-to-view for the TOC trees (IOMapTree, CRTTree).
//
// UI review 2026-10-07: the IO map and the reasoning graph opened at scale 1
// with a fixed offset, so any tree wider or taller than the panel loaded with
// nodes cut off and nothing said so. Given the drawn content's bounding box and
// the viewport, return the zoom (scale + translation) that shows ALL of it,
// centred, never enlarged past `MAX_SCALE`. Pure — unit-tested.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitTransform {
  k: number;
  x: number;
  y: number;
}

const PADDING = 24;
const MAX_SCALE = 1;
const MIN_SCALE = 0.1;

export function fitTransform(content: Box, viewWidth: number, viewHeight: number): FitTransform | null {
  if (!(content.width > 0) || !(content.height > 0) || !(viewWidth > 0) || !(viewHeight > 0)) {
    return null;
  }
  const availW = Math.max(1, viewWidth - 2 * PADDING);
  const availH = Math.max(1, viewHeight - 2 * PADDING);
  const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, availW / content.width, availH / content.height));
  const cx = content.x + content.width / 2;
  const cy = content.y + content.height / 2;
  return { k, x: viewWidth / 2 - k * cx, y: viewHeight / 2 - k * cy };
}
