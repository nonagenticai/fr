// tests/unit/lib/decided-by-kind.test.ts
//
// Migration 211 (cockpit R-CK1): `approval_decisions.decided_by_kind`. Source-shape + pure tests,
// no database (the DB-backed proof — the chat-seat-guard-parity and
// approval-decided-by-kind-backfill integration suites — is no longer in the suite).
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { DECIDED_BY_KINDS } from '../../../src/db/schema';
import { TRIAGE_AGENT_USER_IDS, decidedByKindFor, triageAgentUserIds } from '../../../src/lib/decided-by-kind';

const BACKEND_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const read = (rel: string): string => readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
const MIGRATION = 'migrations/211_approval_decided_by_kind.sql';
const UUID_G = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g;

/** SQL with `--` comment lines removed (the header names the ids too). */
function sqlCode(rel: string): string {
  return read(rel)
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

afterEach(() => {
  delete process.env.FR_TRIAGE_AGENT_USER_IDS;
});

describe('the triage-agent id list has ONE meaning in both places', () => {
  // KILLING MUTATION: add or drop an id in either the migration's IN-list or TRIAGE_AGENT_USER_IDS.
  test("migration 211's backfill IN-list equals TRIAGE_AGENT_USER_IDS", () => {
    const code = sqlCode(MIGRATION);
    const inList = code.slice(code.indexOf('approver_id IN ('), code.indexOf(')', code.indexOf('approver_id IN (')));
    const sqlIds = [...inList.matchAll(UUID_G)].map((m) => m[1]!);
    // CONTROL: the slice found the list (a wrong anchor would read as two empty lists agreeing).
    expect(sqlIds.length).toBeGreaterThanOrEqual(1);
    expect([...sqlIds].sort()).toEqual([...TRIAGE_AGENT_USER_IDS].sort());
    expect(TRIAGE_AGENT_USER_IDS).toContain('72084c2b-d87a-44fe-bcf0-9baddde3be78');
  });

  test("the CHECK as last defined (migration 220, which added 'agent') and schema.ts names exactly DECIDED_BY_KINDS", () => {
    const want = `IN (${DECIDED_BY_KINDS.map((k) => `'${k}'`).join(', ')})`;
    expect(sqlCode('migrations/220_agent_decisions.sql')).toContain(`decided_by_kind ${want}`);
    expect(read('src/db/schema.ts')).toContain(`${'${table.decided_by_kind}'} ${want}`);
  });

  test('the backfill and its receipt are one statement, and nothing writes rule', () => {
    const code = sqlCode(MIGRATION);
    expect(code).toMatch(/WITH moved AS \(\s*UPDATE approval_decisions/);
    expect(code).toContain("INSERT INTO _migration_effects (migration, detail)\nSELECT '211_approval_decided_by_kind.sql'");
    expect(code).not.toContain("SET decided_by_kind = 'rule'");
  });
});

describe('decidedByKindFor', () => {
  test('a built-in triage id (any case) is triage_agent; anything else is human', () => {
    expect(decidedByKindFor('72084c2b-d87a-44fe-bcf0-9baddde3be78')).toBe('triage_agent');
    expect(decidedByKindFor('72084C2B-D87A-44FE-BCF0-9BADDDE3BE78')).toBe('triage_agent');
    expect(decidedByKindFor('d16aa38b-30b7-46af-b47a-ae24d87527f4')).toBe('triage_agent');
    expect(decidedByKindFor('72084c2b-0000-4000-8000-000000000000')).toBe('human'); // prefix is not identity
    expect(decidedByKindFor('c5eab0aa-0000-4000-8000-0000000000b1')).toBe('human');
    expect(decidedByKindFor(null)).toBe('human');
    expect(decidedByKindFor(undefined)).toBe('human');
  });

  test('FR_TRIAGE_AGENT_USER_IDS adds well-formed uuids only and never removes a built-in', () => {
    process.env.FR_TRIAGE_AGENT_USER_IDS = ' AAAAAAAA-0000-4000-8000-000000000001 , not-a-uuid,';
    expect(decidedByKindFor('aaaaaaaa-0000-4000-8000-000000000001')).toBe('triage_agent');
    expect(triageAgentUserIds().has('not-a-uuid')).toBe(false);
    expect(decidedByKindFor('72084c2b-d87a-44fe-bcf0-9baddde3be78')).toBe('triage_agent');
  });
});

/** Every .ts file under backend/src, excluding co-located tests. */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkSrc(full, out);
      continue;
    }
    if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('every approval_decisions insert site sets decided_by_kind explicitly', () => {
  // KILLING MUTATION: delete `decided_by_kind:` from any `.insert(approvalDecisions).values({...})`
  // in backend/src and this goes RED naming the file. The DB default would otherwise silently
  // record a triage agent's decision as a person's.
  test('each `.insert(approvalDecisions).values({` block names decided_by_kind', () => {
    const sites: string[] = [];
    const offenders: string[] = [];
    for (const file of walkSrc(path.join(BACKEND_ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      let at = src.indexOf('.insert(approvalDecisions).values({');
      while (at !== -1) {
        const rel = path.relative(BACKEND_ROOT, file);
        sites.push(rel);
        // The values object: up to its closing `});` at the same call.
        const end = src.indexOf('});', at);
        if (!src.slice(at, end).includes('decided_by_kind:')) offenders.push(rel);
        at = src.indexOf('.insert(approvalDecisions).values({', at + 1);
      }
    }
    // CONTROL: the one insert site is found, so "no offenders" is not an empty scan. Every
    // seat (web, Telegram, Teams, mcp) decides through `recordApprovalDecision`.
    expect([...new Set(sites)].sort()).toEqual(['src/routes/approvals.ts']);
    expect(offenders).toEqual([]);
  });

  test('no raw SQL INSERT INTO approval_decisions exists in backend/src', () => {
    const raw = walkSrc(path.join(BACKEND_ROOT, 'src')).filter((f) =>
      /INSERT\s+INTO\s+approval_decisions/i.test(readFileSync(f, 'utf8')),
    );
    expect(raw).toEqual([]);
  });
});
