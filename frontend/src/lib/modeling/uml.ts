// UML (profile uml-2.5.1-p1) in words, and the helpers the UML pages share.
import type { UmlInteraction, UmlMessage, UmlRelationship } from '$lib/api/modeling';

export const UML_KIND_LABEL: Record<string, string> = {
  package: 'Package',
  class: 'Class',
  interface: 'Interface',
  data_type: 'Data type',
  enumeration: 'Enumeration',
  primitive_type: 'Primitive type',
  component: 'Component',
  port: 'Port',
  actor: 'Actor',
  association: 'Association',
  generalization: 'Generalization',
  interface_realization: 'Interface realization',
  realization: 'Realization',
  dependency: 'Dependency',
  usage: 'Usage',
  connector: 'Connector',
  class_diagram: 'Class diagram',
  component_diagram: 'Component diagram',
  sequence_diagram: 'Sequence diagram',
  synch_call: 'Call (waits for the answer)',
  asynch_call: 'Call (does not wait)',
  asynch_signal: 'Signal',
  reply: 'Reply',
  create: 'Create',
  delete: 'Destroy',
};

/** "Order — association — Customer". */
export function umlRelationshipLabel(r: Pick<UmlRelationship, 'kind' | 'name' | 'source' | 'target' | 'ends'>, nameOf: Map<string, string>): string {
  const n = (id: string | null | undefined) => (id ? (nameOf.get(id) ?? 'an element') : 'an element');
  const [a, b] = r.kind === 'association' && r.ends?.length === 2 ? [r.ends[0]!.element_ref, r.ends[1]!.element_ref] : [r.source, r.target];
  const kind = (UML_KIND_LABEL[r.kind] ?? r.kind).toLowerCase();
  return `${r.name ? `${r.name}: ` : ''}${n(a)} — ${kind} — ${n(b)}`;
}

/** Which elements may own which (the profile's owner kinds). */
export const OWNER_KINDS: Record<string, readonly string[]> = {
  port: ['class', 'component'],
};
export const DEFAULT_OWNER_KINDS = ['package'] as const;

/** Element kinds that carry properties / operations / literals / provided+required interfaces. */
export const FEATURES: Record<string, { properties: boolean; operations: boolean; literals: boolean; interfaces: boolean; abstract: boolean }> = {
  package: { properties: false, operations: false, literals: false, interfaces: false, abstract: false },
  class: { properties: true, operations: true, literals: false, interfaces: false, abstract: true },
  interface: { properties: true, operations: true, literals: false, interfaces: false, abstract: false },
  data_type: { properties: true, operations: true, literals: false, interfaces: false, abstract: false },
  enumeration: { properties: false, operations: false, literals: true, interfaces: false, abstract: false },
  primitive_type: { properties: false, operations: false, literals: false, interfaces: false, abstract: false },
  component: { properties: true, operations: true, literals: false, interfaces: true, abstract: false },
  port: { properties: false, operations: false, literals: false, interfaces: true, abstract: false },
  actor: { properties: false, operations: false, literals: false, interfaces: false, abstract: false },
};

/** A short, model-unique id for a feature / lifeline / message the user adds. */
export function newLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** A message as the sequence editor shows it: who sends to whom, in time order. */
export interface MessageRow {
  id: string;
  kind: string;
  name: string;
  from: string;
  to: string;
  operation_ref: string | null;
  arguments: string[];
  /** Occurrence ids kept from the stored document (new messages get fresh ones). */
  send: string;
  receive: string;
}

/** The stored interaction as editable rows: messages in the order of their send occurrence. */
export function messageRows(doc: Pick<UmlInteraction, 'occurrences' | 'messages'>): MessageRow[] {
  const lifelineOf = new Map(doc.occurrences.map((o) => [o.id, o.lifeline]));
  const pos = new Map(doc.occurrences.map((o, i) => [o.id, i]));
  return [...doc.messages]
    .sort((a, b) => (pos.get(a.send_occurrence) ?? 0) - (pos.get(b.send_occurrence) ?? 0))
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name ?? '',
      from: lifelineOf.get(m.send_occurrence) ?? '',
      to: lifelineOf.get(m.receive_occurrence) ?? '',
      operation_ref: m.operation_ref ?? null,
      arguments: m.arguments ?? [],
      send: m.send_occurrence,
      receive: m.receive_occurrence,
    }));
}

/**
 * The interaction document from the editor's rows: occurrences in time order
 * (each message's send, then its receive), keeping the stored occurrence ids.
 * Occurrences no message uses (an activation's start or end, a fragment's) are
 * kept, after the messages' — `kept` says how many, so the page can say so.
 */
export function documentFromRows(
  doc: Pick<UmlInteraction, 'occurrences'>,
  rows: MessageRow[],
): { occurrences: Array<{ id: string; lifeline: string }>; messages: UmlMessage[]; kept: number } {
  const used = new Set(rows.flatMap((r) => [r.send, r.receive]));
  const occurrences = rows.flatMap((r) => [
    { id: r.send, lifeline: r.from },
    { id: r.receive, lifeline: r.to },
  ]);
  const others = doc.occurrences.filter((o) => !used.has(o.id));
  const messages: UmlMessage[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    send_occurrence: r.send,
    receive_occurrence: r.receive,
    operation_ref: r.operation_ref,
    arguments: r.arguments,
  }));
  return { occurrences: [...occurrences, ...others], messages, kept: others.length };
}
