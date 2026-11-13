import { describe, it, expect } from 'vitest';
import { safeHref } from './safeUrl';

describe('safeHref', () => {
  it('allows http/https/mailto', () => {
    expect(safeHref('https://example.com/doc#p2')).toBe('https://example.com/doc#p2');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('allows relative and scheme-relative URLs', () => {
    expect(safeHref('/library/kag')).toBe('/library/kag');
    expect(safeHref('doc/page')).toBe('doc/page');
    expect(safeHref('//cdn.example.com/x')).toBe('//cdn.example.com/x');
    expect(safeHref('#section')).toBe('#section');
  });

  it('rejects javascript: (the XSS payload)', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined();
  });

  it('rejects javascript: obfuscated with control chars / whitespace', () => {
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined();
    expect(safeHref('  javascript:alert(1)')).toBeUndefined();
    expect(safeHref('java\nscript:alert(1)')).toBeUndefined();
  });

  it('rejects data:, vbscript:, file:, blob: and unknown schemes', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined();
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
    expect(safeHref('blob:https://x/y')).toBeUndefined();
  });

  it('handles non-string / empty input', () => {
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(42)).toBeUndefined();
    expect(safeHref('   ')).toBeUndefined();
  });
});
