// Catalogue section pages — the rules the templates must keep, read from the
// sources (vitest runs in `node`; there is no component renderer in this repo).
//
//  - every section exists as a route and is the target of the 308 map;
//  - every write control sits behind `mode === 'edit'` (members read only);
//  - every refusal is rendered through FailureNotice (the body, verbatim);
//  - the empty / unavailable states come from CatalogueStatus.
import { describe, it, expect } from 'vitest';
import { CATALOGUE_SECTIONS, CATALOGUE_TAB_MAP } from '$lib/conveyor-catalogue/sections';

const PAGES = import.meta.glob('./**/+page.svelte', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const LIB = import.meta.glob('../../../../lib/components/conveyor-catalogue/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const lib = (name: string): string => {
  const hit = Object.entries(LIB).find(([k]) => k.endsWith(`/${name}.svelte`));
  if (!hit) throw new Error(`missing ${name}`);
  return hit[1];
};

/** Template only, comments removed. */
function template(src: string): string {
  return src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

/** The template with every `{#if mode === 'edit' …}` / `{#if editable …}` block cut out (nesting-aware). */
function withoutEditBlocks(t: string): string {
  const open = /\{#if (?:mode === 'edit'|editable\b)/g;
  let out = t;
  for (let m = open.exec(out); m; m = open.exec(out)) {
    const re = /\{#if\b|\{\/if\}/g;
    re.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = out.length;
    for (let n = re.exec(out); n; n = re.exec(out)) {
      depth += n[0] === '{/if}' ? -1 : 1;
      if (depth === 0) {
        end = n.index + n[0].length;
        break;
      }
    }
    out = out.slice(0, m.index) + out.slice(end);
    open.lastIndex = m.index;
  }
  return out;
}

describe('withoutEditBlocks (self-check)', () => {
  it('cuts a gated block, nested ifs included, and leaves the rest', () => {
    const src = "<p>a</p>{#if mode === 'edit' && x}{#if y}<form></form>{/if}{/if}<p>b</p>{#if other}<i></i>{/if}";
    expect(withoutEditBlocks(src)).toBe('<p>a</p><p>b</p>{#if other}<i></i>{/if}');
  });
});

describe('catalogue section routes', () => {
  it('one page per section, and the 308 map points at each', () => {
    for (const s of CATALOGUE_SECTIONS) {
      expect(PAGES[`./${s.slug}/+page.svelte`], s.slug).toBeDefined();
    }
    expect(PAGES['./project-types/[id]/+page.svelte']).toBeDefined();
    expect(PAGES['./phases/[id]/+page.svelte']).toBeDefined();
    expect(CATALOGUE_TAB_MAP.map(([, path]) => path)).toEqual(
      CATALOGUE_SECTIONS.map((s) => `/library/conveyor/catalogue/${s.slug}`),
    );
    // No `Object.keys(PAGES).length` pin: the two extra pages are named above,
    // and every section file is asserted in the loop.
  });

  it('the Tier 2 vocabularies are read-only sections', () => {
    expect(CATALOGUE_SECTIONS.filter((s) => s.readOnly).map((s) => s.resource)).toEqual([
      'wip-limits',
      'priority-levels',
      'deliverable-kinds',
      'milestone-kinds',
      'board-templates',
    ]);
  });

  it('priority levels are ordered by rank, never by name', () => {
    expect(PAGES['./priority-levels/+page.svelte']).toMatch(/byRank\(view\.rows\)/);
    expect(PAGES['./priority-levels/+page.svelte']).toMatch(/\{#each rows as row/);
  });

  it('the phase list shows has_gate and links each phase to its detail (gates)', () => {
    const list = PAGES['./phases/+page.svelte']!;
    expect(list).toContain('row.has_gate');
    expect(list).toContain('/phases/${encodeURIComponent(row.id)}');
    const detail = PAGES['./phases/[id]/+page.svelte']!;
    expect(detail).toContain("listCatalogue<Gate>('gates', { phase_id: id })");
    expect(detail).toContain('phase.has_gate');
  });

  it('every update sends only the changed fields (RM PUT is partial)', () => {
    for (const [file, src] of Object.entries(PAGES)) {
      for (const m of src.matchAll(/updateCatalogueItem<[^>]+>\(([\s\S]*?)\);/g)) {
        expect(m[1], file).toContain('changedFields(');
      }
    }
  });

  it('the capability section is labelled "Conveyor capabilities"', () => {
    expect(CATALOGUE_SECTIONS.find((s) => s.resource === 'capabilities')?.label).toBe('Conveyor capabilities');
    expect(PAGES['./capabilities/+page.svelte']).toContain('title="Conveyor capabilities"');
  });
});

const READ_ONLY = new Set(CATALOGUE_SECTIONS.filter((s) => s.readOnly).map((s) => `./${s.slug}/+page.svelte`));

describe.each(Object.entries(PAGES))('%s', (file, src) => {
  const t = template(src);

  it('reads the caller mode from the shared helper', () => {
    expect(src).toContain("from '$lib/conveyor-catalogue/mode.svelte'");
    expect(src).toMatch(/const mode = \$derived\(currentCatalogueMode\(\)\)/);
  });

  it('every form and every write button is inside an edit-mode branch', () => {
    const writes = /<form\b|>\s*(?:Delete|New [a-z ]+|Edit|Save[a-z ]*)\s*</;
    if (READ_ONLY.has(file)) {
      // A read-only section offers no write control at all, gated or not.
      expect(writes.test(t)).toBe(false);
      return;
    }
    // Positive control: the page HAS write controls to gate.
    expect(writes.test(t)).toBe(true);
    // With every edit-mode block removed, none may remain.
    expect(writes.test(withoutEditBlocks(t))).toBe(false);
  });

  it('renders refusals through FailureNotice', () => {
    expect(t).toMatch(/<FailureNotice\b/);
  });
});

describe('shared components', () => {
  it('FailureNotice shows the message AND the raw body', () => {
    const src = lib('FailureNotice');
    expect(src).toContain('{failure.message}');
    expect(src).toContain('bodyText(failure.body)');
    expect(src).toContain('role="alert"');
  });

  it('CatalogueStatus has distinct unavailable / not-shipped / empty states, import only for admins', () => {
    const src = template(lib('CatalogueStatus'));
    expect(src).toContain('data-testid="catalogue-unavailable"');
    expect(src).toContain('data-testid="catalogue-not-shipped"');
    expect(src).toContain('No catalogue yet — import defaults');
    expect(src).toMatch(/\{#if mode === 'edit'\}\s*<ImportDefaults/);
  });

  it('CatalogueHeader offers import to admins and says read-only to members', () => {
    const src = template(lib('CatalogueHeader'));
    expect(src).toMatch(/\{#if mode === 'edit'\}\s*<ImportDefaults/);
    expect(src).toContain('data-testid="catalogue-read-only"');
  });
});
