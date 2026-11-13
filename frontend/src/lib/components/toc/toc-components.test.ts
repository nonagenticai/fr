// @vitest-environment jsdom
//
// TOC component mount tests (Svelte 5 mount + flushSync), decoupled from the
// API — each component takes data as props. Covers the SVG/DOM components
// (CLRScoreBadge, CLRLensPanel, EvaporatingCloud, and the TocTreeView cloud
// dispatch). The force/tree D3 components rely on requestAnimationFrame timers
// that jsdom doesn't drive, so they're exercised via the page/integration path
// rather than mounted here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import CLRScoreBadge from './CLRScoreBadge.svelte';
import CLRLensPanel from './CLRLensPanel.svelte';
import EvaporatingCloud from './EvaporatingCloud.svelte';
import TocTreeView from './TocTreeView.svelte';
import TocToolResult from './TocToolResult.svelte';
import type { TocGraph, ClrQuality } from '$lib/api/toc';
import { CLR_CATEGORIES } from '$lib/api/toc';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host.remove();
});

const cloudGraph: TocGraph = {
  tree: {
    id: 'EC-1',
    slug: 'ec-1',
    title: 'Ship vs. polish',
    tenant_id: 't',
    tree_type: 'evaporating_cloud',
  },
  nodes: [
    { id: 'A', slug: 'a', tree_id: 'EC-1', tenant_id: 't', title: 'Deliver value', statement: 'goal', node_kind: 'objective', layout: { box: 'A' } },
    { id: 'B', slug: 'b', tree_id: 'EC-1', tenant_id: 't', title: 'Be fast', statement: 'req', node_kind: 'requirement', layout: { box: 'B' } },
    { id: 'C', slug: 'c', tree_id: 'EC-1', tenant_id: 't', title: 'Be safe', statement: 'req', node_kind: 'requirement', layout: { box: 'C' } },
    { id: 'D', slug: 'd', tree_id: 'EC-1', tenant_id: 't', title: 'Ship now', statement: 'pre', node_kind: 'prerequisite', layout: { box: 'D' } },
    { id: 'Dp', slug: 'dp', tree_id: 'EC-1', tenant_id: 't', title: 'Polish first', statement: 'pre', node_kind: 'prerequisite', layout: { box: 'Dprime' } },
  ],
  edges: [
    { id: 'e1', slug: 'e1', tenant_id: 't', source_entity_type: 'toc_nodes', target_entity_type: 'toc_nodes', source_id: 'D', target_id: 'Dp', relationship_type: 'conflict' },
    { id: 'e2', slug: 'e2', tenant_id: 't', source_entity_type: 'toc_nodes', target_entity_type: 'toc_nodes', source_id: 'A', target_id: 'B', relationship_type: 'necessity' },
  ],
};

describe('CLRScoreBadge', () => {
  it('renders the score as a percentage', () => {
    app = mount(CLRScoreBadge, { target: host, props: { score: 0.86 } });
    flushSync();
    expect(host.querySelector('[data-testid="clr-score-badge"]')!.textContent).toContain('86%');
  });
  it('renders an em-dash for a null score', () => {
    app = mount(CLRScoreBadge, { target: host, props: { score: null } });
    flushSync();
    expect(host.querySelector('[data-testid="clr-score-badge"]')!.textContent).toContain('—');
  });
});

describe('CLRLensPanel', () => {
  const quality: ClrQuality = {
    score: 0.75,
    passes: [],
    issues: ['clarity'],
    categories: { clarity: false, tautology: true },
  };

  it('renders every CLR category row and the relevance bar', () => {
    app = mount(CLRLensPanel, {
      target: host,
      props: { quality, goalTreeRelevance: 0.4 },
    });
    flushSync();
    const items = host.querySelectorAll('[data-testid="clr-categories"] li');
    // Derived from the taxonomy the panel maps over, not a literal "8".
    expect(items.length).toBe(CLR_CATEGORIES.length);
    expect(host.querySelector('[data-testid="clr-relevance"]')!.textContent).toContain('40%');
    expect(host.querySelector('[data-testid="clr-issue-count"]')!.textContent).toContain('1 open reservation');
  });

  it('renders an unscored message when quality is null', () => {
    app = mount(CLRLensPanel, { target: host, props: { quality: null } });
    flushSync();
    expect(host.querySelector('[data-testid="clr-lens-panel"]')!.textContent).toContain('No CLR evaluation yet');
  });

  it('asset mode (showCategories=false) hides the grid and lists issues + suggestions', () => {
    app = mount(CLRLensPanel, {
      target: host,
      props: {
        quality: { score: 0.6, passes: [], issues: [], categories: {} },
        showCategories: false,
        issues: ['too vague', 'redundant'],
        suggestions: ['split into two'],
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="clr-categories"]')).toBeNull();
    const reservations = host.querySelector('[data-testid="clr-reservations"]')!;
    expect(reservations.textContent).toContain('too vague');
    expect(reservations.textContent).toContain('Reservations (2)');
    expect(host.querySelector('[data-testid="clr-suggestions"]')!.textContent).toContain('split into two');
  });

  it('asset mode with no reservations shows the pass message', () => {
    app = mount(CLRLensPanel, {
      target: host,
      props: {
        quality: { score: 1, passes: [], issues: [], categories: {} },
        showCategories: false,
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="clr-no-reservations"]')).not.toBeNull();
  });
});

describe('TocToolResult', () => {
  it('renders the tree view for a toc.get_graph result', () => {
    app = mount(TocToolResult, {
      target: host,
      props: { action: 'toc.get_graph', output: { graph: cloudGraph } },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tool-graph"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="evaporating-cloud"]')).not.toBeNull();
  });

  it('parses a stringified output envelope', () => {
    app = mount(TocToolResult, {
      target: host,
      props: {
        action: 'toc.get_quality',
        output: JSON.stringify({ quality: { score: 0.8, passes: [], issues: [], categories: {} } }),
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tool-quality"]')).not.toBeNull();
  });

  it('lists trees for a toc.list_trees result', () => {
    app = mount(TocToolResult, {
      target: host,
      props: {
        action: 'toc.list_trees',
        output: { items: [{ id: 'T-1', tree_type: 'io_map', title: 'Objectives' }] },
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tool-list"]')!.textContent).toContain('Objectives');
  });

  it('shows an execution note for a write action', () => {
    app = mount(TocToolResult, {
      target: host,
      props: { action: 'toc.build_io_map', output: { executionId: 'exec-9' } },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tool-exec"]')!.textContent).toContain('exec-9');
  });

  it('renders nothing it cannot interpret', () => {
    app = mount(TocToolResult, {
      target: host,
      props: { action: 'toc.get_graph', output: 'not json {{{' },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tool-graph"]')).toBeNull();
  });
});

describe('EvaporatingCloud', () => {
  it('renders a box per graph node + a conflict edge label', () => {
    app = mount(EvaporatingCloud, { target: host, props: { graph: cloudGraph } });
    flushSync();
    const rects = host.querySelectorAll('[data-testid="evaporating-cloud"] svg rect');
    // Derived from the input graph, not a literal "5".
    expect(rects.length).toBe(cloudGraph.nodes.length);
    expect(host.querySelector('[data-testid="evaporating-cloud"]')!.textContent).toContain('conflict');
    expect(host.querySelector('[data-testid="evaporating-cloud"]')!.textContent).toContain('Deliver value');
  });
});

describe('TocTreeView', () => {
  it('dispatches an evaporating_cloud tree to the EvaporatingCloud renderer', () => {
    app = mount(TocTreeView, { target: host, props: { graph: cloudGraph } });
    flushSync();
    expect(host.querySelector('[data-testid="evaporating-cloud"]')).not.toBeNull();
  });

  it('shows the empty state for a tree with no nodes', () => {
    app = mount(TocTreeView, {
      target: host,
      props: { graph: { ...cloudGraph, nodes: [], edges: [] } },
    });
    flushSync();
    expect(host.querySelector('[data-testid="toc-tree-empty"]')).not.toBeNull();
  });
});

// P1c-b audit item 2 — TocToolResult paints AGENT tool output, so every field is
// rendered from the agent-redact view. Vector-backed: each `scrub` vector of the ONE
// shared file is a tree title and must render as that vector's `expected`.
// MUTATION (run, red, reverted): return the raw envelope instead of
// `redactForDisplay(...)` in TocToolResult → both cases below are red.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tocVectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../backend/tests/fixtures/redact/mask-vectors.json'), 'utf8'),
) as { scrub: Array<{ name: string; input: string; expected: string }> };
const tocExpand = (t: string): string =>
  t.replace(/«rep:([^:»]+):(\d+)»/g, (_m, unit: string, n: string) => unit.repeat(Number(n)));

describe('TocToolResult — redacted rendering (agent-redact)', () => {
  it('every scrub vector as a tree title renders as its expected (object envelope)', () => {
    expect(tocVectors.scrub.length).toBeGreaterThanOrEqual(10);
    const items = tocVectors.scrub.map((v, i) => ({ id: `T-${i}`, tree_type: 'io_map', title: tocExpand(v.input) }));
    app = mount(TocToolResult, { target: host, props: { action: 'toc.list_trees', output: { items } } });
    flushSync();
    const titles = [...host.querySelectorAll('[data-testid="toc-tool-list"] a')].map((a) => a.textContent?.trim());
    expect(titles).toEqual(tocVectors.scrub.map((v) => tocExpand(v.expected)));
    const titleAttrs = [...host.querySelectorAll('[data-testid="toc-tool-list"] a')].map((a) => a.getAttribute('title'));
    expect(titleAttrs).toEqual(tocVectors.scrub.map((v) => tocExpand(v.expected)));
    // CONTROL: the ids (not secret-shaped) still drive the links.
    expect(host.querySelector('[data-testid="toc-tool-list"] a')?.getAttribute('href')).toBe('/knowledge/toc?tree_id=T-0');
  });

  it('a stringified envelope is redacted too (secret-shaped executionId)', () => {
    const secret = 'ghp_' + 'z'.repeat(30);
    app = mount(TocToolResult, {
      target: host,
      props: { action: 'toc.build_io_map', output: JSON.stringify({ executionId: `exec ${secret}` }) },
    });
    flushSync();
    const text = host.querySelector('[data-testid="toc-tool-exec"]')!.textContent ?? '';
    expect(text).toContain('exec «redacted»');
    expect(text).not.toContain(secret);
  });
});
