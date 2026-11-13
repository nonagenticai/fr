import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SCOPE_FIELD_KEYS } from '$lib/components/ProjectForm.svelte';

// Why this test reads SOURCE TEXT instead of calling the function.
//
// `mapPayloadToForm` is module-private inside `+page.svelte` and there is no
// other test on this route, so there is nothing to import and nothing to mount
// cheaply (the page pulls the whole apiClient + Keycloak at load).
//
// WHAT INVARIANT THIS DEFENDS. `mapPayloadToForm` maps a FIXED list of keys and
// `approve()` posts the FORM-built payload rather than the stored request. So a
// field the request genuinely carries, but which this mapper omits, is
// DESTROYED at reviewer approval — silently, with no error. Measured
// 2026-09-23: all four scope fields were in exactly that state the moment they
// were added to the create form. A field accepted by the API, shown on the
// form, and dropped at review is worse than one never accepted.
//
// ⚠️ THIS TEST WAS REWRITTEN AFTER AN AUDIT PROVED THE FIRST VERSION COULD NOT
// FAIL. The original matched /\bin_scope:\s*p\./ against the whole file. Three
// holes, all measured rather than reasoned:
//   1. COMMENTING OUT the four mapper lines left it GREEN — `\b` matches
//      happily after `// `, so a commented-out line still carries the token.
//      (I first "refuted" this finding by DELETING the lines instead, which
//      does fail. A weaker mutation is not a disproof of a stronger one.)
//   2. It never checked the right-hand side: `in_scope: p.assumptions` passed.
//   3. It was unscoped, so a match anywhere in the file counted.
// Hence: comments stripped, scoped to the function body, and both sides of the
// assignment pinned. The self-test at the bottom re-proves all three.

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '+page.svelte'), 'utf8');

const FN_START = 'function mapPayloadToForm';
const FN_END = 'async function approve';

/** Strip block and line comments so commented-out code cannot satisfy a match. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The body of `mapPayloadToForm` only, comments removed. */
function mapperBody(src: string): string {
	const from = src.indexOf(FN_START);
	const to = src.indexOf(FN_END);
	if (from === -1 || to === -1 || to <= from) return '';
	return stripComments(src.slice(from, to));
}

/** `key: p.key` — both sides pinned, so a swapped source fails. */
const assignsFromPayload = (body: string, key: string): boolean =>
	new RegExp(`(^|[\\s{,])${key}\\s*:\\s*p\\.${key}\\b`).test(body);

const BODY = mapperBody(RAW);

describe('request review page carries every scope field into the form', () => {
	it('located a real, non-trivial mapper body (positive control)', () => {
		// Without this, every assertion below could pass vacuously against ''.
		expect(RAW.length).toBeGreaterThan(2000);
		expect(RAW).toContain(FN_START);
		expect(RAW).toContain(FN_END);
		expect(BODY.length).toBeGreaterThan(200);
	});

	it('matches a key the mapper has always carried (instrument control)', () => {
		// If THIS stops matching, the matcher is broken, not the mapper.
		expect(assignsFromPayload(BODY, 'success_criteria')).toBe(true);
	});

	it('has a non-empty key list to check (positive control)', () => {
		// Guards against SCOPE_FIELD_KEYS being emptied, which would make the
		// per-key loop iterate zero times and report success.
		expect(SCOPE_FIELD_KEYS.length).toBeGreaterThan(0);
	});

	it.each([...SCOPE_FIELD_KEYS])('maps %s out of the stored payload', (key) => {
		// Killing mutation: delete OR comment out `<key>: p.<key> ?? []` in
		// mapPayloadToForm, or point it at a different payload key.
		expect(assignsFromPayload(BODY, key)).toBe(true);
	});

	// The matcher is itself the thing most likely to be wrong here, so it gets
	// its own mutation controls. A gate that cannot fail is worse than no gate:
	// it reports safety it never measured.
	describe('the matcher can actually fail (mutation self-test)', () => {
		const KEY = SCOPE_FIELD_KEYS[0];

		it('rejects a COMMENTED-OUT assignment', () => {
			const mutated = RAW.replace(
				new RegExp(`^(\\s*)${KEY}:\\s*p\\.${KEY}`, 'm'),
				`$1// ${KEY}: p.${KEY}`
			);
			expect(mutated).not.toBe(RAW);
			expect(assignsFromPayload(mapperBody(mutated), KEY)).toBe(false);
		});

		it('rejects a DELETED assignment', () => {
			const mutated = RAW.replace(new RegExp(`^\\s*${KEY}:\\s*p\\.${KEY}[^\\n]*\\n`, 'm'), '');
			expect(mutated).not.toBe(RAW);
			expect(assignsFromPayload(mapperBody(mutated), KEY)).toBe(false);
		});

		it('rejects an assignment pointing at the WRONG payload key', () => {
			const other = SCOPE_FIELD_KEYS[1];
			const mutated = RAW.replace(`${KEY}: p.${KEY}`, `${KEY}: p.${other}`);
			expect(mutated).not.toBe(RAW);
			expect(assignsFromPayload(mapperBody(mutated), KEY)).toBe(false);
		});

		it('rejects a match that lives OUTSIDE the mapper body', () => {
			// Same token, appended after the mapper — must not count.
			const outside = `${RAW}\n// trailing ${KEY}: p.${KEY} reference\n`;
			const deleted = outside.replace(
				new RegExp(`^\\s*${KEY}:\\s*p\\.${KEY}[^\\n]*\\n`, 'm'),
				''
			);
			expect(assignsFromPayload(mapperBody(deleted), KEY)).toBe(false);
		});
	});
});
