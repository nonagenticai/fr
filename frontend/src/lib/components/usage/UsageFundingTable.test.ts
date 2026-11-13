// @vitest-environment jsdom
//
// The /admin/billing + /settings/usage table: dims as rows, funding as columns,
// "Unattributed" for null dims, member ids shown as names, and a footer from
// billing's TRUE totals (not the sum of the visible, possibly truncated rows).

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import UsageFundingTable from './UsageFundingTable.svelte';
import type { UsageFundingBreakdown } from '$lib/usage/funding';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host?.remove();
});

function render(data: UsageFundingBreakdown) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(UsageFundingTable, { target: host, props: { data, testid: 't' } });
  flushSync();
}

const DATA: UsageFundingBreakdown = {
  scope: 'tenant',
  tenant_id: 't',
  from: '2026-10-01',
  to: '2026-10-06',
  group_by: ['project', 'actor', 'funding'],
  cost_basis: 'billed',
  totals: { events: 8, input_tokens: 123456, output_tokens: 7890, cost_usd: 99 },
  by_funding: [
    { funding: 'platform_external', events: 3, cost_usd: 90 },
    { funding: 'tenant_byo', events: 1, cost_usd: 2 },
    { funding: 'local_gpu', events: 4, cost_usd: 7 },
  ],
  rows: [
    { dims: { project: P1, actor: A1, funding: 'platform_external' }, names: { project: 'Alpha', actor: 'Ada', actor_email: 'ada@x.test' }, events: 3, input_tokens: 1000, output_tokens: 200, cost_usd: 10 },
    { dims: { project: P1, actor: A1, funding: 'tenant_byo' }, names: { project: 'Alpha', actor: 'Ada', actor_email: 'ada@x.test' }, events: 1, input_tokens: 500, output_tokens: 50, cost_usd: 2 },
    { dims: { project: null, actor: null, funding: 'local_gpu' }, names: { project: null, actor: null, actor_email: null }, events: 4, input_tokens: 40, output_tokens: 4, cost_usd: 0.5 },
  ],
  truncated: true,
  names_unavailable: { projects: false, actors: false },
};

const cells = (tr: Element | null) => [...(tr?.querySelectorAll('td') ?? [])].map((td) => td.textContent?.replace(/\s+/g, ' ').trim());

describe('UsageFundingTable', () => {
  it('funding columns, member names, Unattributed rows, true totals', () => {
    render(DATA);
    const heads = [...host.querySelectorAll('th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual(['Project', 'Member', 'Local GPU', 'Platform-paid', 'Own key (BYO)', 'Total', 'Input tokens', 'Output tokens', 'Calls']);
    expect(cells(host.querySelector('[data-testid="t-row"]'))).toEqual([
      'Alpha', 'Ada ada@x.test', '', '$10.00', '$2.00', '$12.00', '1,500', '250', '4',
    ]);
    const un = host.querySelector('[data-testid="t-unattributed"]');
    // Exactly ONE "Unattributed" per null-dim cell (live bug after #1471: the
    // label span AND the warning pill both rendered it → "Unattributed Unattributed").
    expect(cells(un).slice(0, 2)).toEqual(['Unattributed', 'Unattributed']);
    // Unattributed spend still shows its tokens (billing counted them, just not to a project).
    expect(cells(un).slice(-3)).toEqual(['40', '4', '4']);
    for (const td of [...(un?.querySelectorAll('td') ?? [])].slice(0, 2)) {
      expect(td.textContent?.match(/Unattributed/g)?.length).toBe(1);
    }
    // Footer is billing's totals (all rows), not the visible-row sum (12.50).
    expect(cells(host.querySelector('[data-testid="t-total"]'))).toEqual([
      'Total', '$7.00', '$90.00', '$2.00', '$99.00', '123,456', '7,890', '8',
    ]);
    expect(host.querySelector('[data-testid="t-truncated"]')).not.toBeNull();
  });
});
