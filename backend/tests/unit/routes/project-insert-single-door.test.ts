// tests/unit/routes/project-insert-single-door.test.ts
//
// ⛔ A project is created ONLY through fr's create/request flow, and that flow
// makes the ONE RM POST (George v4: RM is the source of truth for a project).
// The door is `createSingleProject` (routes/projects.ts). A second writer of
// `projects` rows is a project RM never hears about — exactly what the retired
// AG-UI `agent.create_project` action (chat `start <name>`) was: a Planka
// board + an fr row, no type, no RM POST, human auto-approved.
//
// This test scans every non-test `.ts` file under backend/src and
// backend/scripts for an INSERT into `projects` (drizzle `.insert(projects)` /
// `.insert(x.projects)`, or raw `INSERT INTO projects`) and allows exactly two
// sites, each pinned to the function it must live in:
//
//   * routes/projects.ts `createSingleProject` — the door itself.
//   * routes/project-request-lifecycle.ts `allocatePreApprovalProject` — the
//     request flow's `pending` placeholder row (George 2026-10-08). It is NOT a
//     project RM should know yet: no board, no RM POST; approve PROMOTES that
//     same row through createSingleProject (`existingProjectId`), which makes
//     the RM POST then.
//
// KNOWN LIMIT: it keys on the identifier `projects`. `import { projects as p }`
// then `.insert(p)` is invisible — measured: no such alias exists in src.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BACKEND_ROOT = join(import.meta.dir, '..', '..', '..');
const SCAN_ROOTS = ['src', 'scripts'].map((d) => join(BACKEND_ROOT, d));

const INSERT_RE = /\.insert\(\s*(?:\w+\.)?projects\s*\)|\binsert\s+into\s+"?(?:public\.)?"?projects"?[\s(]/gi;

/** The function each allowed insert must sit inside: `<file>` → function name. */
const ALLOWED: Record<string, string> = {
  'src/routes/projects.ts': 'createSingleProject',
  'src/routes/project-request-lifecycle.ts': 'allocatePreApprovalProject',
};

interface Hit {
  file: string;
  offset: number;
}

function findProjectInserts(file: string, source: string): Hit[] {
  return [...source.matchAll(INSERT_RE)].map((m) => ({ file, offset: m.index ?? 0 }));
}

/** [start, end) of a top-level `export async function <name>(` body (ends at the first column-0 `}`). */
function functionRange(source: string, name: string): [number, number] | null {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) return null;
  const end = source.indexOf('\n}\n', start);
  return [start, end < 0 ? source.length : end];
}

function offendingInserts(file: string, source: string): Hit[] {
  const hits = findProjectInserts(file, source);
  const fn = ALLOWED[file];
  const range = fn ? functionRange(source, fn) : null;
  return hits.filter((h) => !(range && h.offset >= range[0] && h.offset < range[1]));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') walk(p, out);
    } else if (name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('projects rows are inserted ONLY by createSingleProject (+ the request placeholder)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(r));

  test('the scan sees the tree (non-empty scope)', () => {
    // Non-vacuity only — no count of the tree is pinned.
    expect(files.length).toBeGreaterThan(0);
  });

  test('no INSERT into projects outside the two sanctioned functions', () => {
    const offences = files.flatMap((abs) => {
      const rel = relative(BACKEND_ROOT, abs);
      return offendingInserts(rel, readFileSync(abs, 'utf8')).map((h) => `${rel}@${h.offset}`);
    });
    expect(offences).toEqual([]);
  });

  test('each sanctioned function really holds exactly one insert (the allowlist is not stale)', () => {
    for (const [rel, fn] of Object.entries(ALLOWED)) {
      const source = readFileSync(join(BACKEND_ROOT, rel), 'utf8');
      const range = functionRange(source, fn);
      expect(range).not.toBeNull();
      const inside = findProjectInserts(rel, source).filter(
        (h) => h.offset >= range![0] && h.offset < range![1],
      );
      expect(inside.length).toBe(1);
    }
  });

  // Positive controls: the scanner must fire on the shapes it claims to catch.
  test.each([
    ['drizzle insert', 'await db.insert(projects).values(v);'],
    ['drizzle insert, tx + whitespace', 'await tx\n  .insert( projects )\n  .values(v)'],
    ['schema-qualified', 'await db.insert(schema.projects).values(v);'],
    ['raw SQL', "await db.execute(sql`INSERT INTO projects (id, name) VALUES (1, 'x')`);"],
    ['raw SQL, quoted', 'INSERT INTO "projects"(id) VALUES ($1)'],
  ])('flags %s in a non-sanctioned file', (_label, src) => {
    expect(offendingInserts('src/agui/actions/somewhere.ts', src).length).toBe(1);
  });

  test('flags an insert in a sanctioned FILE but outside the sanctioned function', () => {
    const src =
      'export async function createSingleProject(i) {\n  await tx.insert(projects).values(a);\n}\n' +
      'export async function otherCreate() {\n  await db.insert(projects).values(b);\n}\n';
    const offences = offendingInserts('src/routes/projects.ts', src);
    expect(offences.length).toBe(1);
    expect(src.slice(offences[0]!.offset)).toContain('values(b)');
  });

  test('does not flag neighbouring tables', () => {
    const src =
      'await db.insert(projectRequests).values(a); await db.insert(project_stakeholders).values(b);' +
      ' INSERT INTO projects_archive (id) VALUES (1)';
    expect(findProjectInserts('x.ts', src)).toEqual([]);
  });
});
