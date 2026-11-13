// done-equivalent.test.ts
//
// ⛔ EQUALITY, not subset (validator V4 NO-B, 2026-10-06). frontend/src/lib/cards/phase.ts (and so
// ProgressPulse's PUBLISHING count) decides DONE through ./done-equivalent.ts, a copy of the
// backend's ONE DONE predicate (backend/src/lib/done-equivalent.ts). The frontend image is built
// from frontend/ alone, so the copy cannot be an import; this file is what holds the two equal:
//   (1) the SHARED BODY (everything from the marker down) is byte-identical;
//   (2) the two allowlists are the SAME SET;
//   (3) the two normalizers return the same string, and the two predicates the same answer, for
//       every row of the shared name table (backend/tests/fixtures/done-equivalent-names.ts),
//       and each row's expected answer holds — through phase.ts too.
// The backend module is imported directly (pure TS, no Bun APIs).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as fe from './done-equivalent';
import { phaseFromListName } from './phase';
import * as be from '../../../../backend/src/lib/done-equivalent';
import { DONE_TABLE } from '../../../../backend/tests/fixtures/done-equivalent-names';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER = '// ===== SHARED BODY';

function body(path: string): string {
	const src = readFileSync(path, 'utf8');
	const i = src.indexOf(MARKER);
	expect({ path, hasMarker: i >= 0 }).toEqual({ path, hasMarker: true });
	return src.slice(i);
}

describe('frontend DONE predicate copy EQUALS the backend predicate', () => {
	it('shared body is byte-identical', () => {
		expect(body(join(HERE, 'done-equivalent.ts'))).toBe(
			body(join(HERE, '../../../../backend/src/lib/done-equivalent.ts')),
		);
	});

	it('allowlists are the same set', () => {
		expect([...fe.DONE_EQUIVALENT_NAMES].sort()).toEqual([...be.DONE_EQUIVALENT_NAMES].sort());
	});

	it('normalizer, predicate and phase.ts agree with the backend on every shared-table row', () => {
		// Named anchor rather than a table-length floor: proves the shared table
		// is non-empty without pinning how many rows it has today.
		expect(DONE_TABLE.map(([n]) => n)).toContain('DONE');
		const got = DONE_TABLE.map(([n]) => ({
			n,
			norm: fe.normalizeListName(n),
			done: fe.isDoneEquivalentListName(n),
			phase: phaseFromListName(n) === 'PUBLISHING',
		}));
		const want = DONE_TABLE.map(([n, done]) => ({
			n,
			norm: be.normalizeListName(n),
			done,
			phase: done,
		}));
		expect(got).toEqual(want);
		// …and the backend predicate itself gives the table's answer (no shared mistake).
		expect(DONE_TABLE.filter(([n, d]) => be.isDoneEquivalentListName(n) !== d)).toEqual([]);
	});

	it('every allowlisted name is DONE in phase.ts; the live list names are unchanged', () => {
		for (const n of fe.DONE_EQUIVALENT_NAMES) expect({ n, p: phaseFromListName(n) }).toEqual({ n, p: 'PUBLISHING' });
		expect(['', 'DONE', 'TODO', 'READY', 'DOING', 'QA', 'BLOCKED', 'E2E'].map((n) => phaseFromListName(n))).toEqual([
			null,
			'PUBLISHING',
			'READYING',
			'READYING',
			'DOING',
			'INSPECTING',
			null,
			null,
		]);
	});
});
