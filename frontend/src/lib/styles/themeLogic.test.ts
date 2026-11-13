import { describe, it, expect } from 'vitest';
import { resolveTheme, type ThemePreference } from './themeLogic';

describe('resolveTheme', () => {
  it('returns "light" when preference is "light"', () => {
    expect(resolveTheme('light', /* systemPrefersDark */ true)).toBe('light');
  });

  it('returns "dark" when preference is "dark"', () => {
    expect(resolveTheme('dark', /* systemPrefersDark */ false)).toBe('dark');
  });

  it('returns the system value when preference is "system" and system is dark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
  });

  it('returns the system value when preference is "system" and system is light', () => {
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('falls back to "light" for an unrecognized stored preference', () => {
    expect(resolveTheme('whatever' as ThemePreference, false)).toBe('light');
  });
});
