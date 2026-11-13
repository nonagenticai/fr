import { afterEach, describe, expect, it } from 'vitest';

import { activeProject } from '$lib/stores/activeProject.svelte';
import { openKagProjectId, withOpenProject } from './kagProjectScope';

const PROJECT = '7c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

afterEach(() => activeProject.clear());

describe('kag project scope (cost attribution)', () => {
  it('adds project_id when the user has a project open', () => {
    activeProject.setActive({ id: PROJECT, name: 'P', phase: 'request' });
    expect(openKagProjectId()).toBe(PROJECT);
    expect(withOpenProject({ query: 'q', mode: 'dense' })).toEqual({
      query: 'q',
      mode: 'dense',
      project_id: PROJECT,
    });
  });

  it('sends nothing when no project is open', () => {
    const body = withOpenProject({ query: 'q' });
    expect(body).toEqual({ query: 'q' });
    expect('project_id' in body).toBe(false);
  });

  it('a persisted selection outside the project route is NOT billed', () => {
    activeProject.setActive({ id: PROJECT, name: 'P', phase: 'request' });
    activeProject.leaveRoute(PROJECT);
    expect(activeProject.activeId).toBe(PROJECT); // still selected in the header
    expect(openKagProjectId()).toBeUndefined();
    expect('project_id' in withOpenProject({ query: 'q' })).toBe(false);
    activeProject.select(PROJECT);
    expect(openKagProjectId()).toBeUndefined();
  });

  it('a project picked in the header and then opened IS billed', () => {
    activeProject.select(PROJECT);
    expect(openKagProjectId()).toBeUndefined();
    activeProject.setActive({ id: PROJECT, name: '…', phase: 'request' });
    expect(openKagProjectId()).toBe(PROJECT);
  });

  it('re-opening a project after leaving it is billed again', () => {
    activeProject.setActive({ id: PROJECT, name: '…', phase: 'request' });
    activeProject.leaveRoute(PROJECT);
    expect(openKagProjectId()).toBeUndefined();
    activeProject.setActive({ id: PROJECT, name: '…', phase: 'request' });
    expect(openKagProjectId()).toBe(PROJECT);
  });

  it('never sends a stream pseudo-project id', () => {
    activeProject.setActive({ id: `stream:${PROJECT}`, name: 'S', phase: 'request' });
    expect(openKagProjectId()).toBeUndefined();
    expect('project_id' in withOpenProject({ query: 'q' })).toBe(false);
  });
});
