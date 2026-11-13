// fr-agui SPEC §7.5 redirect rules (pure). The page-level tests beside each
// owning route (kanban, cards/[id], threads/[id]) assert the pages act on them.

import { describe, expect, it } from 'vitest';
import {
  cardViewRedirect,
  kanbanBoardRedirect,
  threadViewRedirect,
} from './projectShellRedirects';

describe('kanbanBoardRedirect', () => {
  const boards = [
    { id: 'b-proj', frProjectId: 'p-1' },
    { id: 'b-stream', frProjectId: null },
    { id: 'b-old' }, // older backend: not stated
  ];
  it('a project board goes to that project\'s board', () => {
    expect(kanbanBoardRedirect('b-proj', boards)).toBe('/projects/p-1/board');
  });
  it('a stream board, an unstated board, an unknown board, or no ?board stay on /kanban', () => {
    expect(kanbanBoardRedirect('b-stream', boards)).toBeNull();
    expect(kanbanBoardRedirect('b-old', boards)).toBeNull();
    expect(kanbanBoardRedirect('b-nope', boards)).toBeNull();
    expect(kanbanBoardRedirect(null, boards)).toBeNull();
  });
  it('encodes the project id', () => {
    expect(kanbanBoardRedirect('b', [{ id: 'b', frProjectId: 'a/b' }])).toBe('/projects/a%2Fb/board');
  });
});

describe.each([
  ['cardViewRedirect', cardViewRedirect, 'cards', '/cards'],
  ['threadViewRedirect', threadViewRedirect, 'threads', '/threads'],
] as const)('%s', (_name, fn, seg, tenantBase) => {
  it('tenant view + a project ⇒ the project shell', () => {
    expect(fn('x-1', null, 'p-1')).toBe(`/projects/p-1/${seg}/x-1`);
  });
  it('tenant view + no project (null) or unstated (undefined) ⇒ stay', () => {
    expect(fn('x-1', null, null)).toBeNull();
    expect(fn('x-1', null, undefined)).toBeNull();
  });
  it('project view of its own project ⇒ stay', () => {
    expect(fn('x-1', 'p-1', 'p-1')).toBeNull();
  });
  it('project view of ANOTHER project ⇒ that project', () => {
    expect(fn('x-1', 'p-1', 'p-2')).toBe(`/projects/p-2/${seg}/x-1`);
  });
  it('project view, no project ⇒ the tenant view; unstated ⇒ stay', () => {
    expect(fn('x-1', 'p-1', null)).toBe(`${tenantBase}/x-1`);
    expect(fn('x-1', 'p-1', undefined)).toBeNull();
  });
  it('cannot loop: following any answer once more yields no further hop', () => {
    for (const route of [null, 'p-1', 'p-2'] as const) {
      for (const owner of [null, 'p-1', 'p-2'] as const) {
        const to = fn('x-1', route, owner);
        if (!to) continue;
        const nextRoute = to.startsWith('/projects/') ? to.split('/')[2]! : null;
        expect(fn('x-1', nextRoute, owner), `${route} → ${to}`).toBeNull();
      }
    }
  });
});
