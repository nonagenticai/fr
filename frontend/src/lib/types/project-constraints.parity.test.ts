// project-constraints.parity.test.ts
//
// ⭐ `MACHINE_CHECKABLE_CONSTRAINT_KINDS` (frontend) is a HAND-COPY of
// `CHECKABLE_KINDS` (backend/src/types/project-constraints.ts). Until this file
// existed, the only thing holding the two together was a comment in each saying
// "mirror of the other" — which is not a mechanism, and drifts in silence.
//
// WHY THE DRIFT IS NOT COSMETIC: the frontend copy drives `isMachineCheckable`,
// which drives ConstraintsEditor.svelte's badge and hint ("Checked before merge.
// A pull request that breaks this rule is not merged."). The BACKEND copy drives
// the landing gate that actually refuses the merge. A kind present only in the
// frontend copy therefore makes the UI promise enforcement while the gate reports
// the very same kind as `unchecked` — the UI lying about the user's own request,
// with no type error anywhere.
//
// ⛔ NO HTTP ROUTE. Serving the list at runtime would put a network dependency on
// a static five-element vocabulary, and would still be un-gated at build time.
// A test that goes red on divergence is the cheaper and earlier instrument.
//
// This reads the BACKEND FILE AS TEXT rather than importing it. That is not
// stylistic: CI's `frontend` job (the ts-service archetype) runs `npm ci` in
// frontend/ only, so the backend
// is NOT in this Vite project's module graph, while `actions/checkout@v6` in the
// same job checks out the WHOLE repo, so the backend file IS on disk. A text
// read is the only instrument available from here, and it is sufficient — both
// declarations are plain literal arrays.
//
// MUTATIONS WATCHED before this file was kept:
//   - remove 'no_files_touched' from the FRONTEND list          -> RED
//   - remove "no_files_touched" from the BACKEND list           -> RED
//   - add 'no_bogus_kind' to the FRONTEND list                  -> RED
//   - add "no_bogus_kind" to the BACKEND list                   -> RED

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MACHINE_CHECKABLE_CONSTRAINT_KINDS } from './project-constraints';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_TYPES_FILE = join(HERE, '../../../../backend/src/types/project-constraints.ts');

const SOURCE = readFileSync(BACKEND_TYPES_FILE, 'utf8');

const MARKER = 'export const CHECKABLE_KINDS';

/**
 * Pull the string literals out of the backend's `CHECKABLE_KINDS` declaration.
 *
 * ⚠️ The terminator is a `]` AT THE START OF A LINE, never the first `]` after
 * the marker: the declaration ends
 * `] as const satisfies readonly ProjectConstraint["kind"][];`, so a naive
 * `indexOf(']')` would slice at a bracket belonging to the TYPE ANNOTATION and,
 * depending on which one it hit, could yield an EMPTY list — which would make
 * every comparison below pass vacuously against `[]`. The positive-control test
 * is what stops that being a green no-op.
 */
function backendCheckableKinds(): string[] {
	const at = SOURCE.indexOf(MARKER);
	if (at < 0) throw new Error(`marker not found in the backend file: ${MARKER}`);
	const close = SOURCE.indexOf('\n]', at);
	if (close < 0) throw new Error(`no line-initial closing bracket after: ${MARKER}`);
	const body = SOURCE.slice(at, close);
	return [...body.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]!);
}

describe('CHECKABLE_KINDS parity (frontend hand-copy vs backend source of truth)', () => {
	it('the instrument can actually see the backend declaration (positive control)', () => {
		// Without this, a moved/renamed backend file or a reworded declaration
		// would either throw here or — far worse — parse to `[]` and make the
		// equality assertions below compare nothing to nothing.
		expect(SOURCE).toContain(MARKER);
		expect(SOURCE.length).toBeGreaterThan(1000);

		const parsed = backendCheckableKinds();
		expect(parsed.length).toBeGreaterThan(0);
		// A concrete anchor: proof the parser is reading real members and not,
		// say, the words of a surrounding comment.
		expect(parsed).toContain('no_files_touched');

		// And the frontend side must be non-empty too, or set equality against an
		// empty backend parse would be trivially satisfiable from both ends.
		expect(MACHINE_CHECKABLE_CONSTRAINT_KINDS.length).toBeGreaterThan(0);
	});

	it('names NOTHING the backend gate does not check (no over-claim in the UI)', () => {
		// This is the dangerous direction: an extra kind here makes
		// ConstraintsEditor render "Checked before merge" for a rule the gate
		// reports as `unchecked`.
		const backend = new Set(backendCheckableKinds());
		const extra = [...MACHINE_CHECKABLE_CONSTRAINT_KINDS].filter((k) => !backend.has(k));
		expect(extra).toEqual([]);
	});

	it('names EVERYTHING the backend gate checks (no under-claim in the UI)', () => {
		// The quieter direction: a kind the gate enforces but the badge calls
		// "Guidance — not enforced" understates what the user is held to.
		const frontend = new Set<string>(MACHINE_CHECKABLE_CONSTRAINT_KINDS);
		const missing = backendCheckableKinds().filter((k) => !frontend.has(k));
		expect(missing).toEqual([]);
	});

	it('is the SAME SET, asserted once as sorted arrays', () => {
		// Redundant with the two directional tests on purpose: they name the
		// direction in the failure, this one names the whole diff at a glance.
		expect([...backendCheckableKinds()].sort()).toEqual(
			[...MACHINE_CHECKABLE_CONSTRAINT_KINDS].sort()
		);
	});
});
