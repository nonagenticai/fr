// The former tab-hub roots are 308 stubs (nav standard, owner ruling
// 2026-10-03). Each must land on its FIRST kind by default and translate a
// legacy `?tab=<id>` — the ids the AssetTabs hubs used — to that tab's route,
// so bookmarks and old deep links keep working. Other params ride along.
import { describe, it, expect } from 'vitest';
import { legacyTabTarget } from './legacyTab';
import { load as kagLoad } from '../../routes/library/kag/+page';
import { load as archLoad } from '../../routes/library/architecture/+page';
import { load as governLoad } from '../../routes/govern/architecture/+page';
import { load as governProposalsLoad } from '../../routes/govern/architecture/proposals/+page';
import { load as executionsLoad } from '../../routes/executions/+page';
import { load as repositoriesLoad } from '../../routes/repositories/+page';
import { load as toolsKagLoad } from '../../routes/tools/kag/+page';
import { load as toolsCodingLoad } from '../../routes/tools/coding/+page';
import { load as toolsActivityLoad } from '../../routes/tools/activity/+page';
import { load as verificationLoad } from '../../routes/operate/verification/+page';
import { load as projectArchLoad } from '../../routes/(project)/projects/[id]/architecture/+page';
import { load as projectAssetsLoad } from '../../routes/(project)/projects/[id]/assets/+page';

type Load = (e: never) => unknown;

function redirectOf(load: Load, href: string, params: Record<string, string> = {}): { status?: number; location?: string } {
  try {
    load({ url: new URL(href), params } as never);
    return {};
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('legacyTabTarget', () => {
  const MAP = [
    ['a', '/x/a'],
    ['b', '/x/b'],
  ] as const;

  it('no tab → the first kind', () => {
    expect(legacyTabTarget(new URL('http://h/x'), MAP)).toBe('/x/a');
  });
  it('a known tab → its route; an unknown tab → the first kind', () => {
    expect(legacyTabTarget(new URL('http://h/x?tab=b'), MAP)).toBe('/x/b');
    expect(legacyTabTarget(new URL('http://h/x?tab=zzz'), MAP)).toBe('/x/a');
  });
  it('drops `tab` and keeps every other param', () => {
    expect(legacyTabTarget(new URL('http://h/x?projectId=p1&tab=b&container=c'), MAP)).toBe(
      '/x/b?projectId=p1&container=c',
    );
  });
  it('refuses an empty map rather than redirecting nowhere', () => {
    expect(() => legacyTabTarget(new URL('http://h/x'), [])).toThrow();
  });
});

// [hub load, hub path, [legacy tab id, expected route]…] — the FIRST pair is
// also the default. Tab ids are spelled as the deleted AssetTabs hubs had them.
const HUBS: [string, Load, string, [string, string][]][] = [
  ['KAG', kagLoad as Load, '/library/kag', [
    ['documents', '/library/kag/documents'],
    ['ingestion', '/library/kag/web-sources'],
    ['media', '/library/kag/media'],
    ['graph', '/library/kag/graph'],
    ['entities', '/library/kag/entities'],
    ['discover', '/library/kag/discover'],
    ['scientific', '/library/kag/scientific'],
    ['text-analysis', '/library/kag/text-analysis'],
    ['ask', '/library/kag/ask'],
    ['health', '/library/kag/health'],
    ['benchmarks', '/library/kag/benchmarks'],
    ['capabilities', '/library/kag/capabilities'],
  ]],
  ['Architecture', archLoad as Load, '/library/architecture', [
    ['elements', '/library/architecture/elements'],
    ['relationships', '/library/architecture/relationships'],
    ['views', '/library/architecture/views'],
    ['standards', '/library/architecture/standards'],
  ]],
  ['Conformance', governLoad as Load, '/govern/architecture', [
    ['dashboard', '/govern/architecture/dashboard'],
    ['graph', '/govern/architecture/graph'],
    // The Proposals tab's queue was removed (RM #238): a legacy link lands on the dashboard.
    ['queue', '/govern/architecture/dashboard'],
  ]],
  ['Executions', executionsLoad as Load, '/executions', [
    ['n8n', '/executions/n8n'],
    ['activity', '/executions/activity'],
  ]],
  ['Repositories', repositoriesLoad as Load, '/repositories', [
    ['repositories', '/repositories/registry'],
    ['analysis', '/repositories/analysis'],
  ]],
  ['Verification', verificationLoad as Load, '/operate/verification', [
    ['determinism', '/operate/verification/determinism'],
  ]],
];

// Project-scoped hubs (validator A1/A2): the destination carries the project id.
const P = 'proj-1';
// The project Architecture root is a PAGE since 2026-10-28 (the project's
// Architecture hub); only its legacy `?tab=` links still 308 — pinned below.
const PROJECT_ARCH_TABS: [string, string][] = [
  ['architecture', `/projects/${P}/architecture/graph`],
  ['graph', `/projects/${P}/architecture/graph`],
  ['dependencies', `/projects/${P}/architecture/dependencies`],
  ['quality', `/projects/${P}/architecture/quality-gate`],
  ['quality-gate', `/projects/${P}/architecture/quality-gate`],
];

describe('Project architecture root is the Architecture hub; legacy ?tab= links still land on their view', () => {
  const hub = `/projects/${P}/architecture`;
  it('bare (or an unknown tab) → no redirect: the hub page renders', () => {
    expect(redirectOf(projectArchLoad as Load, `http://h${hub}`, { id: P })).toEqual({});
    expect(redirectOf(projectArchLoad as Load, `http://h${hub}?tab=zzz`, { id: P })).toEqual({});
  });
  it.each(PROJECT_ARCH_TABS)('legacy ?tab=%s → %s', (tab, route) => {
    expect(redirectOf(projectArchLoad as Load, `http://h${hub}?tab=${tab}`, { id: P })).toEqual({ status: 308, location: route });
  });
  it('keeps other params', () => {
    expect(redirectOf(projectArchLoad as Load, `http://h${hub}?tab=dependencies&q=x`, { id: P })).toEqual({
      status: 308,
      location: `/projects/${P}/architecture/dependencies?q=x`,
    });
  });
});

const PROJECT_HUBS: [string, Load, string, [string, string][]][] = [
  ['Project assets (5D)', projectAssetsLoad as Load, `/projects/${P}/assets`, [
    ['principles', `/projects/${P}/library/principles`],
    ['requirements', `/projects/${P}/library/requirements`],
    ['decisions', `/projects/${P}/library/decisions`],
  ]],
];

describe.each(PROJECT_HUBS)('%s root is a 308 stub', (_name, load, hub, tabs) => {
  it('bare → 308 to the first view', () => {
    expect(redirectOf(load, `http://h${hub}`, { id: P })).toEqual({ status: 308, location: tabs[0]![1] });
  });
  it.each(tabs)('legacy ?tab=%s → %s', (tab, route) => {
    expect(redirectOf(load, `http://h${hub}?tab=${tab}`, { id: P })).toEqual({ status: 308, location: route });
  });
  it('keeps other params', () => {
    expect(redirectOf(load, `http://h${hub}?tab=${tabs[1]![0]}&q=x`, { id: P })).toEqual({
      status: 308,
      location: `${tabs[1]![1]}?q=x`,
    });
  });
});

describe.each(HUBS)('%s hub root is a 308 stub', (_name, load, hub, tabs) => {
  it('bare hub → 308 to the first kind', () => {
    expect(redirectOf(load, `http://h${hub}`)).toEqual({ status: 308, location: tabs[0]![1] });
  });

  it.each(tabs)('legacy ?tab=%s → %s', (tab, route) => {
    expect(redirectOf(load, `http://h${hub}?tab=${tab}`)).toEqual({ status: 308, location: route });
  });
});

it('Conformance keeps its project across the legacy hop (the removed queue tab lands on the dashboard)', () => {
  const r = redirectOf(governLoad as Load, 'http://h/govern/architecture?projectId=p1&container=fr&tab=queue');
  expect(r).toEqual({ status: 308, location: '/govern/architecture/dashboard?projectId=p1&container=fr' });
});

it('the removed /govern/architecture/proposals view is a 308 to the dashboard, keeping its project (not a 404)', () => {
  expect(redirectOf(governProposalsLoad as Load, 'http://h/govern/architecture/proposals')).toEqual({
    status: 308,
    location: '/govern/architecture/dashboard',
  });
  expect(redirectOf(governProposalsLoad as Load, 'http://h/govern/architecture/proposals?projectId=p1')).toEqual({
    status: 308,
    location: '/govern/architecture/dashboard?projectId=p1',
  });
});

describe('/tools/* stubs point at the per-kind routes, not at ?tab=', () => {
  it.each([
    [toolsKagLoad as Load, '/library/kag/web-sources'],
    [toolsCodingLoad as Load, '/repositories/analysis'],
    [toolsActivityLoad as Load, '/executions/activity'],
  ])('%#', (load, dest) => {
    expect(redirectOf(load, 'http://h/tools/x')).toEqual({ status: 308, location: dest });
  });
});
