// rightPane.test.ts
//
// Plain runes-store tests — no DOM needed. Module state is shared across
// tests so we reset via `clear()` in beforeEach.

import { describe, it, expect, beforeEach } from 'vitest';
import { rightPane, openDetailPane, paneKey } from './rightPane.svelte';
import { agentRail } from './agentRail.svelte';

beforeEach(() => {
  rightPane.clear();
  agentRail.reset();
});

describe('rightPane', () => {
  it('starts empty (no content)', () => {
    expect(rightPane.kind).toBeNull();
    expect(rightPane.id).toBeNull();
    expect(rightPane.meta).toBeNull();
    expect(rightPane.isOpen()).toBe(false);
  });

  it('setContent installs kind+id and exposes meta', () => {
    rightPane.setContent({
      kind: 'kag-session',
      id: 'sess-1',
      meta: { title: 'KAG run 1' },
    });
    expect(rightPane.kind).toBe('kag-session');
    expect(rightPane.id).toBe('sess-1');
    expect(rightPane.meta).toEqual({ title: 'KAG run 1' });
    expect(rightPane.isOpen()).toBe(true);
  });

  it('setContent without meta defaults meta to null', () => {
    rightPane.setContent({ kind: 'coding-job', id: 'job-1' });
    expect(rightPane.kind).toBe('coding-job');
    expect(rightPane.meta).toBeNull();
  });

  it('replacing content overwrites prior state', () => {
    rightPane.setContent({ kind: 'kanban-card', id: 'c1' });
    rightPane.setContent({ kind: 'bridge-draft', id: 'd2', meta: { source: 'agent' } });
    expect(rightPane.kind).toBe('bridge-draft');
    expect(rightPane.id).toBe('d2');
    expect(rightPane.meta).toEqual({ source: 'agent' });
  });

  it('openDetailPane sets content AND reveals it', () => {
    // setContent alone is invisible: the rail defaults closed and defaults to
    // the [Agent] tab, so the ContextualPane never renders. The composite is
    // the only way a caller can do the whole job.
    openDetailPane({ kind: 'kag-session', id: 'sess-9' });
    expect(rightPane.kind).toBe('kag-session');
    expect(rightPane.id).toBe('sess-9');
    expect(agentRail.isOpen).toBe(true);
    expect(agentRail.tab).toBe('detail');
  });

  it('paneKey changes when meta changes, even at the same kind+id', () => {
    // BridgeDraftView reads meta.project_id in onMount. If the key ignored meta,
    // reopening the same draft under a different project would keep the FIRST
    // project's data while the header claimed the second.
    const a = paneKey('bridge-draft', 'd-1', { project_id: 'p-1' });
    const b = paneKey('bridge-draft', 'd-1', { project_id: 'p-2' });
    expect(a).not.toBe(b);
  });

  it('paneKey is stable for the same content', () => {
    // A key that changed every call would remount on every unrelated store read.
    expect(paneKey('n8n-execution', 'e-1', null)).toBe(
      paneKey('n8n-execution', 'e-1', null),
    );
  });

  it('paneKey survives an unserialisable meta instead of throwing', () => {
    const cyclic: Record<string, unknown> = { project_id: 'p-1' };
    cyclic.self = cyclic;
    const k = paneKey('bridge-draft', 'd-1', cyclic);
    expect(typeof k).toBe('string');
    expect(k).toContain('unserialisable');
  });

  it('clear resets everything', () => {
    rightPane.setContent({ kind: 'n8n-execution', id: 'e1' });
    rightPane.clear();
    expect(rightPane.kind).toBeNull();
    expect(rightPane.id).toBeNull();
    expect(rightPane.meta).toBeNull();
    expect(rightPane.isOpen()).toBe(false);
  });
});
