import { resolveTheme, type ThemePreference, type EffectiveTheme } from '$lib/styles/themeLogic';

const STORAGE_KEY = 'fr-theme';
const VALID: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function loadStoredPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const raw = localStorage.getItem(STORAGE_KEY);
  return VALID.includes(raw as ThemePreference) ? (raw as ThemePreference) : 'system';
}

export function storePreference(pref: ThemePreference): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, pref);
}

export function applyTheme(root: HTMLElement, effective: EffectiveTheme): void {
  if (effective === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

class ThemeStore {
  preference = $state<ThemePreference>('system');
  effective = $state<EffectiveTheme>('light');

  private mediaQuery: MediaQueryList | null = null;
  private mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

  initialize(): void {
    if (typeof window === 'undefined') return;
    this.preference = loadStoredPreference();
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaListener = () => this.recompute();
    this.mediaQuery.addEventListener('change', this.mediaListener);
    this.recompute();
  }

  setPreference(pref: ThemePreference): void {
    this.preference = pref;
    storePreference(pref);
    this.recompute();
  }

  destroy(): void {
    if (this.mediaQuery && this.mediaListener) {
      this.mediaQuery.removeEventListener('change', this.mediaListener);
    }
    this.mediaQuery = null;
    this.mediaListener = null;
  }

  private recompute(): void {
    const systemDark = this.mediaQuery?.matches ?? false;
    this.effective = resolveTheme(this.preference, systemDark);
    if (typeof document !== 'undefined') {
      applyTheme(document.documentElement, this.effective);
    }
  }
}

export const theme = new ThemeStore();
