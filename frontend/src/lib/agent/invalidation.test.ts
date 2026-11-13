// fr-agui SPEC §5.3 / §13 P1c-b — the state-invalidate bus.
//
// MUTATION (run, red, reverted): drop the `KEY_RE.test(r)` filter in
// raiseInvalidate → "ignores keys outside the backend's shapes" is red.
import { afterEach, describe, expect, it } from 'vitest';

import { onInvalidate, raiseInvalidate } from './invalidation';

const offs: Array<() => void> = [];
afterEach(() => {
	while (offs.length) offs.pop()!();
});

describe('state-invalidate bus', () => {
	it('calls a subscriber for its exact keys only, once per raise', () => {
		const seen: string[] = [];
		offs.push(onInvalidate(['board:p1', 'approvals:me'], (k) => seen.push(k)));
		expect(raiseInvalidate(['board:p1', 'approvals:me', 'board:p2'])).toEqual(['board:p1', 'approvals:me', 'board:p2']);
		expect(seen).toEqual(['board:p1']);
	});

	it('ignores keys outside the backend’s shapes', () => {
		const seen: string[] = [];
		offs.push(onInvalidate('board:p1', (k) => seen.push(k)));
		expect(raiseInvalidate(['board:p1 ', 'BOARD:p1', 'board:', 42, null, 'board:p1/../x'])).toEqual([]);
		expect(seen).toEqual([]);
	});

	it('unsubscribe removes the listener; a throwing listener does not stop the others', () => {
		const seen: string[] = [];
		const off = onInvalidate('project:p1', () => {
			throw new Error('boom');
		});
		offs.push(onInvalidate('project:p1', (k) => seen.push(k)));
		raiseInvalidate(['project:p1']);
		expect(seen).toEqual(['project:p1']);
		off();
		// After unsubscribing, a raise reaches only the remaining listener (no throw).
		raiseInvalidate(['project:p1']);
		expect(seen).toEqual(['project:p1', 'project:p1']);
	});
});
