// Pure fixtures + the pure view logic; no fetching, no doubles.

import { describe, expect, test } from 'vitest';
import type { Project } from '$lib/types/api';
import {
  DEFAULT_PORTFOLIO_SORT,
  PORTFOLIO_SORT_OPTIONS,
  filterProjects,
  sortProjects,
  projectTimestamp,
} from './portfolio-view';

function project(
  over: Partial<Project> & Pick<Project, 'id' | 'name'>,
): Project {
  return {
    owner_id: 'owner-1',
    repository_url: null,
    branch: 'main',
    status: 'active',
    shape: 'deliverable',
    repository_provisioned: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('filterProjects', () => {
  const projects = [
    project({
      id: 'a',
      name: 'Release readiness tracker',
      description: 'Internal tool for the delivery team',
      repository_url: 'https://github.com/acme/release-tracker',
    }),
    project({
      id: 'b',
      name: 'Stock valuation',
      repositories: [
        {
          repo_id: 'r1',
          url: 'https://github.com/acme/valuation-svc',
          branch: 'main',
          name: 'valuation-svc',
          path: null,
          is_primary: true,
          position: 0,
        },
      ],
    }),
    project({ id: 'c', name: 'Kata replay sandbox' }),
  ];

  test('a blank query returns every project', () => {
    expect(filterProjects(projects, '').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(filterProjects(projects, '   ').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  test('matches the name case-insensitively', () => {
    expect(filterProjects(projects, 'KATA').map((p) => p.id)).toEqual(['c']);
  });

  test('matches the description and the primary repository url', () => {
    expect(filterProjects(projects, 'delivery team').map((p) => p.id)).toEqual(['a']);
    expect(filterProjects(projects, 'release-tracker').map((p) => p.id)).toEqual(['a']);
  });

  test('matches a repository in the reported set', () => {
    expect(filterProjects(projects, 'valuation-svc').map((p) => p.id)).toEqual(['b']);
  });

  test('absent repositories are not a match and never throw', () => {
    expect(filterProjects(projects, 'zzz')).toEqual([]);
  });

  test('does not mutate its input', () => {
    const before = projects.map((p) => p.id);
    filterProjects(projects, 'kata');
    expect(projects.map((p) => p.id)).toEqual(before);
  });
});

describe('sortProjects', () => {
  const createdEarly = project({
    id: 'early',
    name: 'Early',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
  });
  const createdLate = project({
    id: 'late',
    name: 'Late',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
  });
  const projects = [createdLate, createdEarly];

  test('orders by created_at, newest and oldest', () => {
    expect(sortProjects(projects, 'created_desc').map((p) => p.id)).toEqual(['late', 'early']);
    expect(sortProjects(projects, 'created_asc').map((p) => p.id)).toEqual(['early', 'late']);
  });

  test('orders by updated_at, newest and oldest', () => {
    expect(sortProjects(projects, 'updated_desc').map((p) => p.id)).toEqual(['early', 'late']);
    expect(sortProjects(projects, 'updated_asc').map((p) => p.id)).toEqual(['late', 'early']);
  });

  test('keeps input order for equal timestamps', () => {
    const a = project({ id: 'a', name: 'A', created_at: '2026-10-01T00:00:00.000Z' });
    const b = project({ id: 'b', name: 'B', created_at: '2026-10-01T00:00:00.000Z' });
    expect(sortProjects([b, a], 'created_desc').map((p) => p.id)).toEqual(['b', 'a']);
  });

  test('an unparsable timestamp reads as 0 and never throws', () => {
    const broken = project({ id: 'broken', name: 'Broken', created_at: 'not-a-date' });
    const good = project({ id: 'good', name: 'Good', created_at: '2026-10-01T00:00:00.000Z' });
    expect(sortProjects([broken, good], 'created_asc').map((p) => p.id)).toEqual(['broken', 'good']);
    expect(sortProjects([broken, good], 'created_desc').map((p) => p.id)).toEqual(['good', 'broken']);
  });

  test('does not mutate its input', () => {
    const before = projects.map((p) => p.id);
    sortProjects(projects, 'updated_asc');
    expect(projects.map((p) => p.id)).toEqual(before);
  });

  test('every option value is a real sort and the default is offered', () => {
    expect(PORTFOLIO_SORT_OPTIONS.length).toBe(4);
    expect(PORTFOLIO_SORT_OPTIONS.map((o) => o.value)).toContain(DEFAULT_PORTFOLIO_SORT);
    expect(new Set(PORTFOLIO_SORT_OPTIONS.map((o) => o.value)).size).toBe(4);
    for (const o of PORTFOLIO_SORT_OPTIONS) {
      expect(sortProjects(projects, o.value)).toHaveLength(2);
    }
  });
});

describe('projectTimestamp', () => {
  test('prints the local date and time, from a string or a Date', () => {
    const d = new Date(2026, 9, 13, 8, 40);
    expect(projectTimestamp(d)).toBe('2026-10-13 08:40');
    expect(projectTimestamp(d.toISOString())).toBe('2026-10-13 08:40');
  });

  test('passes an unparsable string through', () => {
    expect(projectTimestamp('not-a-date')).toBe('not-a-date');
  });
});
