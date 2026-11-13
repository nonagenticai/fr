// src/lib/stores/agentRail.test.ts
//
// Unit tests for the agentRail store. The store is the single source of
// truth for the right-rail Agent UI: open/close, active thread, project
// pin, and the [agent | detail] tab.

import { describe, it, expect, beforeEach } from 'vitest';
import { agentRail } from './agentRail.svelte';

describe('agentRail store', () => {
  beforeEach(() => agentRail.reset());

  it('starts closed with no thread or project', () => {
    expect(agentRail.isOpen).toBe(false);
    expect(agentRail.activeThreadId).toBeNull();
    expect(agentRail.projectId).toBeNull();
    expect(agentRail.tab).toBe('agent');
  });

  it('open() sets isOpen true', () => {
    agentRail.open();
    expect(agentRail.isOpen).toBe(true);
  });

  it('toggle() flips isOpen', () => {
    agentRail.toggle();
    expect(agentRail.isOpen).toBe(true);
    agentRail.toggle();
    expect(agentRail.isOpen).toBe(false);
  });

  it('openThread(id) opens rail and sets activeThreadId', () => {
    agentRail.openThread('t-123');
    expect(agentRail.isOpen).toBe(true);
    expect(agentRail.activeThreadId).toBe('t-123');
    expect(agentRail.tab).toBe('agent');
  });

  it('openDetail() opens the rail ON the detail tab', () => {
    // The ContextualPane only renders on this tab, and the rail defaults
    // closed — so both must move together or an "Open" button is inert.
    agentRail.openDetail();
    expect(agentRail.isOpen).toBe(true);
    expect(agentRail.tab).toBe('detail');
  });

  it('showsThread is FALSE on the detail tab even though the rail is open', () => {
    // The whole point: `isOpen` and "a thread is on screen" diverge once the
    // rail can open on [Detail]. close() keeps activeThreadId (only reset()
    // clears it), so anything describing the visible thread — the ?thread= URL
    // param, the thread fetch — must ask this, not isOpen.
    agentRail.openThread('t-1');
    expect(agentRail.showsThread).toBe(true);
    agentRail.close();
    expect(agentRail.showsThread).toBe(false);
    expect(agentRail.activeThreadId).toBe('t-1'); // deliberately retained

    agentRail.openDetail();
    expect(agentRail.isOpen).toBe(true);
    expect(agentRail.activeThreadId).toBe('t-1'); // still retained
    expect(agentRail.showsThread).toBe(false); // but NOT what is showing
  });

  it('setProjectContext(id) records the project pin without opening', () => {
    agentRail.setProjectContext('p-9');
    expect(agentRail.projectId).toBe('p-9');
    expect(agentRail.isOpen).toBe(false);
  });

  it('clearProjectContext() nulls the pin', () => {
    agentRail.setProjectContext('p-9');
    agentRail.clearProjectContext();
    expect(agentRail.projectId).toBeNull();
  });

  it('switchTab() changes the active tab', () => {
    agentRail.open();
    agentRail.switchTab('detail');
    expect(agentRail.tab).toBe('detail');
  });

  it('close() closes but preserves activeThreadId', () => {
    agentRail.openThread('t-1');
    agentRail.close();
    expect(agentRail.isOpen).toBe(false);
    expect(agentRail.activeThreadId).toBe('t-1');
  });
});

// fr-agui P1c-b: a thread refused on a surface (bound to another project) is not
// re-opened there by a stale ?thread= link; a new surface forgets the refusal.
// MUTATION (run, red, reverted): make isRefusedThread return false → red.
describe('agentRail.refuseThread (P1c-b)', () => {
  it('refuses on this surface only', () => {
    agentRail.reset();
    agentRail.setProjectContext('p-a');
    agentRail.openThread('t-q');
    agentRail.refuseThread('t-q');
    expect(agentRail.activeThreadId).toBeNull();
    expect(agentRail.isRefusedThread('t-q')).toBe(true);
    agentRail.setProjectContext('p-a');
    expect(agentRail.isRefusedThread('t-q')).toBe(true);
    agentRail.setProjectContext('p-q');
    expect(agentRail.isRefusedThread('t-q')).toBe(false);
    agentRail.reset();
  });
});
