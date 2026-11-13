import { describe, expect, it } from 'vitest';
import { fitTransform } from './fit';

describe('fitTransform', () => {
  it('shrinks a too-wide tree so all of it is visible, centred', () => {
    const t = fitTransform({ x: -1000, y: 0, width: 2000, height: 300 }, 800, 600)!;
    // (800 - 2 × 24px padding) / 2000
    expect(t.k).toBeCloseTo(0.376);
    // Content centre (0, 150) lands on the viewport centre (400, 300).
    expect(t.x + t.k * 0).toBeCloseTo(400);
    expect(t.y + t.k * 150).toBeCloseTo(300);
  });

  it('never enlarges a small tree past scale 1', () => {
    const t = fitTransform({ x: 0, y: 0, width: 100, height: 50 }, 800, 600)!;
    expect(t.k).toBe(1);
  });

  it('clamps to scale 0.1 for huge content', () => {
    expect(fitTransform({ x: 0, y: 0, width: 1e6, height: 10 }, 800, 600)!.k).toBe(0.1);
  });

  it('returns null for an empty or unmeasurable box (jsdom has no layout)', () => {
    expect(fitTransform({ x: 0, y: 0, width: 0, height: 0 }, 800, 600)).toBeNull();
    expect(fitTransform({ x: 0, y: 0, width: 10, height: 10 }, 0, 600)).toBeNull();
  });
});
