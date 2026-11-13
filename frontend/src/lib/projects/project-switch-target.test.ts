import { describe, expect, it } from 'vitest';
import { projectSwitchTarget } from './project-switch-target';

describe('projectSwitchTarget', () => {
  it('keeps the sub-path when switching inside a project', () => {
    expect(projectSwitchTarget('/projects/a/board', 'b')).toBe('/projects/b/board');
    expect(projectSwitchTarget('/projects/a/library/decisions', 'b')).toBe(
      '/projects/b/library/decisions',
    );
    expect(projectSwitchTarget('/projects/a', 'b')).toBe('/projects/b');
  });

  it('opens the project page from non-project pages', () => {
    expect(projectSwitchTarget('/kanban', 'b')).toBe('/projects/b');
    expect(projectSwitchTarget('/approvals', 'b')).toBe('/projects/b');
    expect(projectSwitchTarget('/cards/123', 'b')).toBe('/projects/b');
    expect(projectSwitchTarget('/projects', 'b')).toBe('/projects/b');
    expect(projectSwitchTarget('/projects/new', 'b')).toBe('/projects/b');
    expect(projectSwitchTarget('/projects/requests/9', 'b')).toBe('/projects/b');
  });

  it('drops a per-approval sub-path that belongs to the old project', () => {
    expect(projectSwitchTarget('/projects/a/approve/x', 'b')).toBe('/projects/b');
  });
});
