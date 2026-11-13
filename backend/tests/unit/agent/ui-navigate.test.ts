// tests/unit/agent/ui-navigate.test.ts
//
// fr-agui SPEC §5.4 — the agent's navigation intents. The project agent opens
// pages of ITS OWN project shell only; the doorway agent opens the doorway pages
// or a project it can read. External URLs, dot segments and query strings are
// refused. PROJECT_SHELL_ROUTES is pinned against the SvelteKit route manifest
// (frontend/src/routes/(project)/projects/[id]/**), so a page added or removed
// there reds here until the list follows.
//
// MUTATION (run, red, reverted — see the P1c report): drop the
// `target !== bound` check in checkNavigation → "another project" red.

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { checkNavigation, DOORWAY_ROUTES, NavigationRefusedError, PROJECT_SHELL_ROUTES } from '../../../src/agui/actions/ui-navigate';
import { ProjectMismatchError } from '../../../src/agent/project-binding';

const A = '0195f48b-d000-7000-8000-0000000000aa';
const B = '0195f48b-d000-7000-8000-0000000000bb';
const readable = async (id: string) => id === A;

function shellManifest(): string[] {
  const root = join(import.meta.dir, '../../../../frontend/src/routes/(project)/projects/[id]');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === '+page.svelte') out.push(relative(root, dir));
    }
  };
  walk(root);
  return out
    .map((r) => r.replace(/\[approvalId\]|\[threadId\]|\[artifactId\]/g, ':uuid').replace(/\[cardId\]/g, ':id'))
    .sort();
}

describe('the project shell route list = the SvelteKit manifest', () => {
  test('every (project) page is listed, and nothing else', () => {
    const manifest = shellManifest();
    // Non-vacuity only: the filesystem scan found pages. No count — the set
    // equality below is the assertion.
    expect(manifest.length).toBeGreaterThan(0);
    expect([...PROJECT_SHELL_ROUTES].sort()).toEqual(manifest);
  });

  test('the doorway pages exist', () => {
    for (const r of DOORWAY_ROUTES) {
      const dir = join(import.meta.dir, '../../../../frontend/src/routes', r.replace('/:uuid', '/[id]'));
      expect(statSync(join(dir, '+page.svelte')).isFile()).toBe(true);
    }
  });
});

describe('checkNavigation', () => {
  test('the project agent: its own shell pages only', async () => {
    const bound = { projectId: A };
    expect(await checkNavigation(`/projects/${A}/board`, bound, readable)).toBe(`/projects/${A}/board`);
    expect(await checkNavigation(`/projects/${A}`, bound, readable)).toBe(`/projects/${A}`);
    expect(await checkNavigation(`/projects/${A}/approve/${B}`, bound, readable)).toBe(`/projects/${A}/approve/${B}`);
    expect(await checkNavigation(`/projects/${A}/cards/1764170980260840476`, bound, readable)).toBe(`/projects/${A}/cards/1764170980260840476`);
    await expect(checkNavigation(`/projects/${B}/board`, bound, readable)).rejects.toBeInstanceOf(ProjectMismatchError);
    await expect(checkNavigation(`/projects/${A}/admin`, bound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
    await expect(checkNavigation('/settings/secrets', bound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
    await expect(checkNavigation('/projects/new', bound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
  });

  test('the doorway agent: the doorway pages, or a READABLE project root', async () => {
    const unbound = { projectId: null };
    expect(await checkNavigation('/projects/new', unbound, readable)).toBe('/projects/new');
    expect(await checkNavigation(`/projects/requests/${B}`, unbound, readable)).toBe(`/projects/requests/${B}`);
    expect(await checkNavigation(`/projects/${A}`, unbound, readable)).toBe(`/projects/${A}`);
    await expect(checkNavigation(`/projects/${B}`, unbound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
    await expect(checkNavigation(`/projects/${A}/board`, unbound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
    await expect(checkNavigation('/admin/licenses', unbound, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
  });

  test('never an external URL, a dot segment, a query or a fragment', async () => {
    for (const r of ['https://evil.example/x', '//evil.example', `/projects/${A}/../x`, `/projects/${A}/board?x=1`, `/projects/${A}/board#f`, 'board']) {
      await expect(checkNavigation(r, { projectId: A }, readable)).rejects.toBeInstanceOf(NavigationRefusedError);
    }
  });
});
