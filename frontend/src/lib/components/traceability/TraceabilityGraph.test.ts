// @vitest-environment jsdom
//
// TraceabilityGraph — Phase-4 knowledge-graph depth controls. Mounts the real
// D3 component and asserts (a) the dimension filter (visibleDimensions prop)
// drops hidden-dimension nodes and their dangling links, and (b) the hover
// tooltip renders the per-relationship-type inbound/outbound breakdown.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import TraceabilityGraph from './TraceabilityGraph.svelte';
import type { TraceDimension, TraceNode, TraceLink } from '$lib/api/traceability';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

const NODES: TraceNode[] = [
  {
    id: 'architecture_elements:a1',
    label: 'ArchA1',
    dimension: 'architecture',
    entity_type: 'architecture_elements',
    entity_id: 'a1',
    route: '/library/architecture/elements/a1',
    is_root: true,
  },
  {
    id: 'requirements:r1',
    label: 'ReqR1',
    dimension: 'requirement',
    entity_type: 'requirements',
    entity_id: 'r1',
    route: '/requirements/r1',
    is_root: false,
  },
  {
    id: 'decisions:d1',
    label: 'DecD1',
    dimension: 'decision',
    entity_type: 'decisions',
    entity_id: 'd1',
    route: '/decisions/d1',
    is_root: false,
  },
];

// a1 → r1 (realizes, outbound from a1); d1 → a1 (depends_on, inbound to a1).
const LINKS: TraceLink[] = [
  { source: 'architecture_elements:a1', target: 'requirements:r1', type: 'realizes', label: null },
  { source: 'decisions:d1', target: 'architecture_elements:a1', type: 'depends_on', label: null },
];

const ALL_DIMS = new Set<TraceDimension>(['architecture', 'requirement', 'decision']);

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});

function mountGraph(visibleDimensions: Set<TraceDimension>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(TraceabilityGraph, {
    target: host,
    props: { data: { nodes: NODES, links: LINKS }, visibleDimensions },
  });
  flushSync();
}

describe('TraceabilityGraph dimension filter', () => {
  it('renders one circle per visible node', async () => {
    mountGraph(ALL_DIMS);
    await settle();
    expect(host.querySelectorAll('svg circle').length).toBe(3);
  });

  it('hides nodes whose dimension is filtered out (and their dangling links)', async () => {
    // Only architecture visible → a1 alone; both links dangle to hidden nodes.
    mountGraph(new Set<TraceDimension>(['architecture']));
    await settle();
    expect(host.querySelectorAll('svg circle').length).toBe(1);
    expect(host.querySelectorAll('svg line').length).toBe(0);
  });
});

describe('TraceabilityGraph tooltip breakdown', () => {
  it('shows inbound/outbound counts grouped by relationship type', async () => {
    mountGraph(ALL_DIMS);
    await settle();

    // Find a1's node group via its (untruncated) label text.
    const labels = [...host.querySelectorAll<SVGTextElement>('svg text')];
    const a1Text = labels.find((t) => t.textContent === 'ArchA1');
    expect(a1Text).toBeTruthy();
    const group = a1Text!.closest('g');
    expect(group).toBeTruthy();

    group!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await settle();

    const tip = host.querySelector('div.absolute.z-20') as HTMLDivElement | null;
    expect(tip).toBeTruthy();
    expect(tip!.textContent).toContain('Connections: 2');
    expect(tip!.textContent).toContain('realizes: 1 out');
    expect(tip!.textContent).toContain('depends_on: 1 in');
  });
});

describe('TraceabilityGraph tooltip escaping', () => {
  it('renders label, entity_type and relationship type as text, never markup', async () => {
    const evil: TraceNode[] = [
      { ...NODES[0], label: '<img id=pwn1>', entity_type: '<img id=pwn2>' },
      NODES[1],
    ];
    const evilLinks: TraceLink[] = [
      { source: evil[0].id, target: evil[1].id, type: '<img id=pwn3>', label: null },
    ];
    host = document.createElement('div');
    document.body.appendChild(host);
    app = mount(TraceabilityGraph, {
      target: host,
      props: { data: { nodes: evil, links: evilLinks }, visibleDimensions: ALL_DIMS },
    });
    flushSync();
    await settle();

    const labels = [...host.querySelectorAll<SVGTextElement>('svg text')];
    const group = labels.find((t) => t.textContent === '<img id=pwn1>')!.closest('g');
    group!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await settle();

    const tip = host.querySelector('div.absolute.z-20') as HTMLDivElement;
    expect(tip.querySelector('img')).toBeNull();
    expect(tip.textContent).toContain('<img id=pwn1>');
    expect(tip.textContent).toContain('Type: <img id=pwn2>');
    expect(tip.textContent).toContain('<img id=pwn3>: 1 out');
  });
});
