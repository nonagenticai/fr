import { describe, expect, it } from 'vitest';
import { documentFromRows, messageRows, umlRelationshipLabel } from './uml';

const doc = {
  occurrences: [
    { id: 'o1', lifeline: 'L1' },
    { id: 'o2', lifeline: 'L2' },
    { id: 'x9', lifeline: 'L2' },
    { id: 'o3', lifeline: 'L2' },
    { id: 'o4', lifeline: 'L1' },
  ],
  messages: [
    { id: 'm2', kind: 'reply', name: 'ok', send_occurrence: 'o3', receive_occurrence: 'o4' },
    { id: 'm1', kind: 'synch_call', name: 'pay', send_occurrence: 'o1', receive_occurrence: 'o2' },
  ],
};

describe('the sequence editor model', () => {
  it('reads messages in time order with sender and receiver', () => {
    expect(messageRows(doc).map((r) => `${r.id} ${r.from}->${r.to}`)).toEqual(['m1 L1->L2', 'm2 L2->L1']);
  });
  it('writes occurrences in message order, keeping ids and the unused ones (counted)', () => {
    const rows = messageRows(doc).reverse();
    const out = documentFromRows(doc, rows);
    expect(out.occurrences.map((o) => o.id)).toEqual(['o3', 'o4', 'o1', 'o2', 'x9']);
    expect(out.kept).toBe(1);
    expect(out.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
  });
  it('a changed receiver moves the receive occurrence to that lifeline', () => {
    const rows = messageRows(doc);
    rows[0]!.to = 'L3';
    expect(documentFromRows(doc, rows).occurrences.find((o) => o.id === 'o2')!.lifeline).toBe('L3');
  });
});

it('relationship labels name both ends', () => {
  const names = new Map([
    ['a', 'Order'],
    ['b', 'Customer'],
  ]);
  expect(umlRelationshipLabel({ kind: 'association', name: '', source: null, target: null, ends: [{ element_ref: 'a' }, { element_ref: 'b' }] }, names)).toBe('Order — association — Customer');
  expect(umlRelationshipLabel({ kind: 'generalization', name: 'is a', source: 'a', target: 'zz', ends: null }, names)).toBe('is a: Order — generalization — an element');
});
