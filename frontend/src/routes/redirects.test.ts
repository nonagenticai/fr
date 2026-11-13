// Launcher/index pages that were replaced by top-level sidebar rows. Each
// bare URL 308s to the one real page so bookmarks keep working.
import { describe, it, expect } from 'vitest';
import { load as settingsLoad } from './settings/+page';
import { load as preferencesLoad } from './settings/preferences/+page';
import { load as engagementsLoad } from './engagements/+page';
import { load as projectsLoad } from './projects/+page';

function redirectOf(load: (e: never) => unknown): { status?: number; location?: string } {
  try {
    load({} as never);
    return {};
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('index-page redirects', () => {
  it.each([
    ['/settings', settingsLoad, '/settings/account'],
    ['/settings/preferences', preferencesLoad, '/settings/account'],
    ['/engagements', engagementsLoad, '/engagements/deliveries'],
    ['/projects', projectsLoad, '/'],
  ])('%s 308s to %s', (_from, load, dest) => {
    const r = redirectOf(load as (e: never) => unknown);
    expect(r.status).toBe(308);
    expect(r.location).toBe(dest);
  });
});
