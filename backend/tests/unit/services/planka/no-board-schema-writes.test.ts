// v4 ruling 12 (George 2026-10-13): the RM board template is the master. fr
// creates custom-field groups/fields ONLY when it builds a board from the
// template; no card-write path may add one. This pins the callers of every
// schema-writing helper so a new "self-heal" cannot creep back in.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../../../../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = sourceFiles(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));

function callers(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.rel).sort();
}

describe('only board creation writes board custom-field schema', () => {
  test('provisionBoardFieldGroups is called only by the two board-create paths', () => {
    expect(callers(/provisionBoardFieldGroups\(/)).toEqual([
      'services/planka/custom-fields.ts',
      'services/planka/intake.ts',
      'services/streams/repository.ts',
    ]);
  });

  test('the low-level group/field creators are used only inside custom-fields.ts', () => {
    expect(callers(/\.(provisionTemplateGroup|createBoardGroup|createFieldInGroup)\(/)).toEqual([
      'services/planka/custom-fields.ts',
    ]);
  });

  test('no source file still references the removed ensure helpers', () => {
    expect(callers(/ensureAllImprovementGroups|ensureCardCustomFieldGroup/)).toEqual([]);
  });

  test('positive control: the scan sees the card writers', () => {
    expect(callers(/resolveBoardFieldGroups\(/)).toContain('routes/kanban/cards.ts');
  });
});
