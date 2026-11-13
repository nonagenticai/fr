export type ThemePreference = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): EffectiveTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return 'light';
}
