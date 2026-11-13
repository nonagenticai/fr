// fr-agui SPEC §5.4 / §13 P1c-b audit item 1 — the browser's own fail-closed
// check on a `ui-intent` route RESOLVES the route the way the browser will
// (`new URL`) and validates the RESOLVED path, so an encoded dot segment can
// never walk out of the bound project's shell.
//
// MUTATION (run, red, reverted — see the P1c-b audit-fix report): the previous
// check (literal `.` / `..` segments only, `%` allowed) passes
// `/projects/P/%2e%2e/Q/board` and `/projects/P/.%2E/.%2e/settings`, which the
// browser resolves to `/projects/Q/board` and `/settings`; every "refused" case
// below except the plain ones was red against it.
import { describe, expect, it } from 'vitest';
import { checkUiIntent } from './ui-intent';

const P = '0195f48b-d000-7000-8000-0000000000a1';
const Q = '0195f48b-d000-7000-8000-0000000000b2';

/** What a browser does with the route (the thing `goto` and `<a href>` follow). */
const resolved = (route: string): string => {
	const u = new URL(route, 'https://fr.example');
	return u.origin === 'https://fr.example' ? u.pathname : u.href;
};

describe('ui-intent bound to project P: resolve, then validate', () => {
	const refused: Array<[string, string]> = [
		['encoded parent into another project', `/projects/${P}/%2e%2e/${Q}/board`],
		['mixed-case encoded dots to a tenant page', `/projects/${P}/.%2E/.%2e/settings`],
		['upper-case %2E%2E', `/projects/${P}/%2E%2E/${Q}`],
		['half-encoded %2e.', `/projects/${P}/%2e./${Q}`],
		['encoded slash', `/projects/${P}%2f..%2f${Q}`],
		['encoded slash upper-case', `/projects/${P}/..%2F${Q}`],
		['encoded backslash', `/projects/${P}/..%5c${Q}`],
		['encoded backslash upper-case', `/projects/${P}/..%5C..%5Csettings`],
		['double-encoded dot', `/projects/${P}/%252e%252e/${Q}/board`],
		['encoded dots in the query', `/projects/${P}/board?next=%2e%2e`],
		['literal backslash', `/projects/${P}/..\\${Q}`],
		['backslash host', '\\\\evil.example/x'],
		['slash-backslash host', '/\\evil.example/x'],
		['protocol-relative', '//evil.example/projects/' + P],
		['javascript scheme', 'javascript:alert(1)'],
		['javascript scheme, upper-case', 'JavaScript:alert(1)'],
		['https scheme', `https://evil.example/projects/${P}`],
		['same-origin absolute URL (a scheme is never a route)', `http://localhost:3000/projects/${P}`],
		['data scheme', 'data:text/html,<script>1</script>'],
		['another project', `/projects/${Q}/board`],
		['another project root', `/projects/${Q}`],
		['a prefix that is not the project segment', `/projects/${P}x/board`],
		['literal dot-dot', `/projects/${P}/../${Q}`],
		['literal dot', `/projects/${P}/./board`],
		['tenant page', '/settings'],
		['tab smuggled into a segment', `/projects/${P}/.\t./${Q}`],
		['fragment', `/projects/${P}/board#x`]
	];
	for (const [name, route] of refused) {
		it(`refuses ${name}: ${JSON.stringify(route)} (browser → ${JSON.stringify(resolved(route))})`, () => {
			expect(checkUiIntent(route, P).ok).toBe(false);
		});
	}

	it('CONTROL: the encoded probes really DO resolve outside the shell (not vacuous)', () => {
		expect(resolved(`/projects/${P}/%2e%2e/${Q}/board`)).toBe(`/projects/${Q}/board`);
		expect(resolved(`/projects/${P}/.%2E/.%2e/settings`)).toBe('/settings');
	});

	const allowed = [`/projects/${P}`, `/projects/${P}/`, `/projects/${P}/board`, `/projects/${P}/cards/abc_1-2`, `/projects/${P}/board?tab=open`];
	for (const route of allowed) {
		it(`CONTROL: allows ${route}`, () => {
			const v = checkUiIntent(route, P);
			expect(v).toEqual({ ok: true, route });
		});
	}

	it('the returned route is the RESOLVED path + query (what goto and the chip both follow)', () => {
		const v = checkUiIntent(`/projects/${P}/board?tab=open`, P);
		expect(v.ok && v.route).toBe(`/projects/${P}/board?tab=open`);
	});
});

describe('ui-intent unbound (doorway)', () => {
	const refused = [
		'/projects/intake/%2e%2e/%2e%2e/settings',
		`/projects/requests/%2e%2e/${Q}/board`,
		`/projects/${P}/board`,
		'/kanban',
		'//evil.example',
		'javascript:alert(1)'
	];
	for (const route of refused) {
		it(`refuses ${JSON.stringify(route)}`, () => {
			expect(checkUiIntent(route, null).ok).toBe(false);
		});
	}
	for (const route of ['/projects/intake', '/projects/new', '/projects/requests', `/projects/requests/abc`, `/projects/${P}`]) {
		it(`CONTROL: allows ${route}`, () => {
			expect(checkUiIntent(route, null)).toEqual({ ok: true, route });
		});
	}
});
