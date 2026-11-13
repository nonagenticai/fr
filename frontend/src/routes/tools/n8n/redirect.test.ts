// +page.ts load: /tools/n8n 308-redirects to /executions/n8n (the former
// /executions n8n tab, its own route since the nav standard, 2026-10-03).
//
// ⛔ THE DEFECT THIS FILE PINS. The redirect used to be a bare
// `redirect(308, '/executions')`, which threw the incoming query string away
// and landed on whatever tab /executions defaults to. Every sibling in
// /tools/* either preserves `url.search` (tools/bridge) or sets the tab
// (tools/activity, tools/coding, tools/kag), and `routes/executions/+page.svelte`
// documents "/tools/n8n → ?tab=n8n" in its own header — which did not happen.
// A deep link's params reaching the destination is the whole point of a 308.
//
// Convention mirrors ../../library/[type]/redirect.test.ts.

import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(href: string): { status?: number; location?: string } {
  try {
    // Minimal shape — load() only reads url.
    const res = load({ url: new URL(href) } as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    // SvelteKit redirect() throws a { status, location } object.
    return e as { status: number; location: string };
  }
}

describe('/tools/n8n +page.ts redirect', () => {
  it('preserves the incoming search params on the n8n executions route', () => {
    const r = redirectOf('http://h/tools/n8n?execution=42');
    expect(r.status).toBe(308);

    const dest = new URL(r.location as string, 'http://h');
    expect(dest.pathname).toBe('/executions/n8n');
    // The param a deep link carried must survive the hop.
    expect(dest.searchParams.get('execution')).toBe('42');
    // No tab param: the destination is a single view, not a tab hub.
    expect(dest.searchParams.has('tab')).toBe(false);
  });

  it('a bare /tools/n8n lands on /executions/n8n with no query at all', () => {
    const r = redirectOf('http://h/tools/n8n');
    expect(r.status).toBe(308);
    expect(r.location).toBe('/executions/n8n');
  });

  it('an explicit tab in the incoming URL is dropped, never forwarded', () => {
    // This route IS the n8n surface; it cannot honestly forward tab=activity.
    const r = redirectOf('http://h/tools/n8n?tab=activity&execution=7');
    const dest = new URL(r.location as string, 'http://h');
    expect(dest.pathname).toBe('/executions/n8n');
    expect(dest.searchParams.has('tab')).toBe(false);
    expect(dest.searchParams.get('execution')).toBe('7');
  });
});
