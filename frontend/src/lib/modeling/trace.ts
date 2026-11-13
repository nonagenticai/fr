// Trace links in words: what each kind of item is called, where its page is,
// how a link reads ("realizes", "traces to"), and the item's own name (read from
// the page's own API). requirements_management stores only kinds and ids.
import { assetFetch } from '$lib/api/assets';
import { getUml, type TraceKind, type TraceLink, type TraceLinkType } from '$lib/api/modeling';

// Each map is keyed by RM's GENERATED enum (TraceRefKind / TraceLinkInLinkType):
// a kind RM adds or drops fails the typecheck here, so the pickers can never
// offer a value RM refuses or miss one it accepts.
export const TRACE_KIND_LABEL: Record<TraceKind, string> = {
  requirement: 'Requirement',
  principle: 'Principle',
  decision: 'Decision',
  element: 'Architecture element',
  relationship: 'Architecture relationship',
  view: 'Architecture view',
  uml_element: 'UML element',
  uml_relationship: 'UML relationship',
  interaction: 'UML interaction',
  diagram: 'UML diagram',
};

export const LINK_VERB: Record<TraceLinkType, string> = {
  realizes: 'realizes',
  refines: 'refines',
  traces_to: 'traces to',
  satisfies: 'satisfies',
  implements: 'implements',
  depends_on: 'depends on',
};

/** Every kind and link type, in the order the pickers show them. */
export const TRACE_KINDS = Object.keys(TRACE_KIND_LABEL) as TraceKind[];
export const TRACE_LINK_TYPES = Object.keys(LINK_VERB) as TraceLinkType[];

/** The passive form, for a link that ends at the item being viewed. */
export const LINK_VERB_PASSIVE: Record<TraceLinkType, string> = {
  realizes: 'is realized by',
  refines: 'is refined by',
  traces_to: 'is traced from',
  satisfies: 'is satisfied by',
  implements: 'is implemented by',
  depends_on: 'is depended on by',
};

export function traceHref(kind: string, id: string): string | null {
  const e = encodeURIComponent(id);
  switch (kind) {
    case 'requirement':
      return `/requirements/${e}`;
    case 'principle':
      return `/principles/${e}`;
    case 'decision':
      return `/decisions/${e}`;
    case 'element':
      return `/library/architecture/elements/${e}`;
    case 'relationship':
      return `/library/architecture/relationships/${e}`;
    case 'view':
      return `/library/architecture/views/${e}`;
    case 'uml_element':
      return `/library/architecture/uml/elements/${e}`;
    case 'uml_relationship':
      return `/library/architecture/uml/relationships/${e}`;
    case 'interaction':
      return `/library/architecture/uml/interactions/${e}`;
    case 'diagram':
      return `/library/architecture/uml/diagrams/${e}`;
    default:
      return null;
  }
}

/** The item's own name, read from its page's API. Throws when it cannot be read. */
export async function traceItemName(kind: string, id: string): Promise<string> {
  const e = encodeURIComponent(id);
  const title = (row: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  switch (kind) {
    case 'requirement':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/requirements/${e}`), 'title', 'name');
    case 'principle':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/principles/${e}`), 'title', 'name');
    case 'decision':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/decisions/${e}`), 'title', 'name');
    case 'element':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/architecture/elements/${e}`), 'title', 'name');
    case 'relationship':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/architecture/relationships/${e}`), 'title', 'relationship_type');
    case 'view':
      return title(await assetFetch<Record<string, unknown>>(`/api/assets/architecture/views/${e}`), 'title', 'name');
    case 'uml_element':
      return title(await getUml<Record<string, unknown>>('elements', id), 'name');
    case 'uml_relationship':
      return title(await getUml<Record<string, unknown>>('relationships', id), 'name', 'kind');
    case 'interaction':
      return title(await getUml<Record<string, unknown>>('interactions', id), 'name');
    case 'diagram':
      return title(await getUml<Record<string, unknown>>('diagrams', id), 'name');
    default:
      throw new Error(`no page knows a ${kind}`);
  }
}

/** How a link reads from the item being viewed (`selfId`): the verb and the other end. */
export function linkFromHere(link: TraceLink, selfId: string): { verb: string; other: { kind: string; id: string } | null; code: TraceLink['target_code'] } {
  if (link.source.id === selfId) {
    return { verb: LINK_VERB[link.link_type as TraceLinkType] ?? link.link_type, other: link.target, code: link.target_code };
  }
  return { verb: LINK_VERB_PASSIVE[link.link_type as TraceLinkType] ?? link.link_type, other: link.source, code: null };
}
