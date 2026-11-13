// Deploy-resilience hook — pure logic tests (no browser). Covers the
// dynamic-import-failure detection.

import { describe, expect, it } from 'vitest';
import { isDynamicImportError } from './hooks.client';

describe('isDynamicImportError', () => {
	it('matches the SvelteKit dynamic-import failure messages', () => {
		expect(
			isDynamicImportError(
				new Error('Failed to fetch dynamically imported module: https://fr/_app/x.js')
			)
		).toBe(true);
		expect(isDynamicImportError(new Error('Importing a module script failed.'))).toBe(true);
		expect(
			isDynamicImportError('error loading dynamically imported module')
		).toBe(true);
	});
	it('does not match unrelated errors', () => {
		expect(isDynamicImportError(new Error('TypeError: x is not a function'))).toBe(false);
		expect(isDynamicImportError(new Error('network request failed'))).toBe(false);
		expect(isDynamicImportError(undefined)).toBe(false);
		expect(isDynamicImportError(null)).toBe(false);
	});
});
