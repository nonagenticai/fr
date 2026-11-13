import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('neutralizes a script-tag payload', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('neutralizes an img/onerror payload', () => {
    const out = escapeHtml('<img src=x onerror="alert(document.cookie)">');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror="');
    expect(out).toContain('&lt;img');
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('breaks out-of-attribute injection via quotes', () => {
    // A value placed inside an attribute must not be able to close it.
    expect(escapeHtml('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)',
    );
  });

  it('handles null/undefined/non-string input safely', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('leaves benign text unchanged', () => {
    expect(escapeHtml('Module: auth-service')).toBe('Module: auth-service');
  });
});
