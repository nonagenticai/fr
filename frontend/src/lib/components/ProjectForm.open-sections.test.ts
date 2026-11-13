import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the `openSections` state against declaring panels the form does not render.
//
// ⭐ The two sides come from DIFFERENT PRODUCERS on purpose: the numerator is the
// `$state` object literal, the denominator is the template's `{#if openSections.X}`
// blocks. A guard that derived both from one parse of one region could not detect
// the regression it exists to prevent.
//
// The defect this pins: `people`, `secrets_docs` and `resources` were declared and
// never rendered, so the source described three collapsible sections that do not
// exist. An operator reviewing the form reasonably read that as "these sections are
// in the form but broken".
const SRC = readFileSync(
	fileURLToPath(new URL('./ProjectForm.svelte', import.meta.url)),
	'utf-8'
);

function declaredKeys(src: string): string[] {
	const m = src.match(/let openSections = \$state<Record<string, boolean>>\(\{([\s\S]*?)\}\);/);
	if (!m) throw new Error('openSections declaration not found — parser is broken, not the code');
	return [...m[1].matchAll(/^\s*([a-z_]+):\s*(?:true|false)\s*,?\s*$/gm)].map((x) => x[1]);
}

function renderedKeys(src: string): string[] {
	return [...src.matchAll(/\{#if openSections\.([a-z_]+)\}/g)].map((x) => x[1]);
}

function toggledKeys(src: string): string[] {
	return [...src.matchAll(/toggleSection\('([a-z_]+)'\)/g)].map((x) => x[1]);
}

describe('ProjectForm openSections', () => {
	it('parses a non-empty declaration (fails closed if the parser rots)', () => {
		// Without this, every assertion below could pass on an empty set.
		expect(declaredKeys(SRC).length).toBeGreaterThanOrEqual(6);
		expect(renderedKeys(SRC).length).toBeGreaterThanOrEqual(6);
	});

	it('declares exactly the sections it renders — no dead keys, no missing state', () => {
		const declared = [...new Set(declaredKeys(SRC))].sort();
		const rendered = [...new Set(renderedKeys(SRC))].sort();
		expect(declared).toEqual(rendered);
	});

	it('every declared section has a toggle control', () => {
		const declared = [...new Set(declaredKeys(SRC))].sort();
		const toggled = [...new Set(toggledKeys(SRC))].sort();
		expect(toggled).toEqual(declared);
	});
});
