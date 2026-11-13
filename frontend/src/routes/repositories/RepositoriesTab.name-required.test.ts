// RepositoriesTab — the repository name is never blank.
//
// The backend stores `repositories.name` as NOT NULL + `CHECK (btrim(name) <> '')`
// (migration 133) and derives `owner/repo` from the url when the caller omits the
// field. This form therefore must NOT require a name — that would take away the
// derivation — but it MUST catch the one case the backend has to refuse: an empty
// name over a url with no `owner/repo` in it. Without this the user gets an opaque
// 400 banner instead of a message on the field they have to fix.
//
// ⭐ KILLING MUTATIONS:
//   · make the name unconditionally required in `validateRepositoryForm` → the
//     "blank name over a derivable url is VALID" arms go RED. That is the arm
//     that protects the derivation from being undone by a well-meaning
//     `if (!name) error`.
//   · drop the name check entirely (revert to url-only validation) → every
//     "underivable url" arm goes RED.
//   · drop the `.trim()` in the name check → the whitespace-only arm goes RED.
//   · break `deriveRepositoryNameFromUrl`'s `.git` strip, trailing-slash filter,
//     scp branch or first-two-segments rule → the matching derivation arm.

import { describe, expect, it } from 'vitest';
import {
	deriveRepositoryNameFromUrl,
	validateRepositoryForm
} from './RepositoriesTab.svelte';

const NO_ERRORS = { name: '', url: '' };

describe('deriveRepositoryNameFromUrl (frontend mirror of backend/src/lib/repository-name.ts)', () => {
	it('https url → owner/repo', () => {
		expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo')).toBe('owner/repo');
	});

	it('https url with a trailing .git → owner/repo', () => {
		expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
	});

	it('https url with a trailing slash → owner/repo', () => {
		expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo/')).toBe('owner/repo');
	});

	it('scp-style git@host:owner/repo.git → owner/repo', () => {
		expect(deriveRepositoryNameFromUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
	});

	it('a deeper path takes the FIRST two segments (last-two would give tree/main)', () => {
		expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo/tree/main')).toBe(
			'owner/repo'
		);
	});

	it('non-github hosts work too', () => {
		expect(deriveRepositoryNameFromUrl('https://gitlab.com/group/thing.git')).toBe('group/thing');
	});

	it.each([
		['not a url at all'],
		[''],
		['   '],
		['https://github.com/owner'],
		['https://github.com']
	])('%s → null (never an invented name)', (url) => {
		expect(deriveRepositoryNameFromUrl(url)).toBeNull();
	});
});

describe('validateRepositoryForm', () => {
	it('a blank name over a DERIVABLE url is VALID — the backend fills in owner/repo', () => {
		expect(validateRepositoryForm({ name: '', url: 'https://github.com/owner/repo.git' })).toEqual(
			NO_ERRORS
		);
	});

	it('a blank name over a derivable scp url is VALID', () => {
		expect(validateRepositoryForm({ name: '', url: 'git@github.com:owner/repo.git' })).toEqual(
			NO_ERRORS
		);
	});

	it('a supplied name is always VALID, whatever the url shape', () => {
		expect(validateRepositoryForm({ name: 'My Backend', url: 'internal-mirror' })).toEqual(
			NO_ERRORS
		);
	});

	it('a blank name over an UNDERIVABLE url is a field error on NAME', () => {
		const errors = validateRepositoryForm({ name: '', url: 'https://example.invalid/only-one' });
		expect(errors.url).toBe('');
		expect(errors.name).toContain('Name is required');
	});

	it('a WHITESPACE-ONLY name over an underivable url is a field error on NAME', () => {
		// The backend 422s a whitespace-only name rather than storing it, so the
		// form must not treat '   ' as "the user supplied a name".
		const errors = validateRepositoryForm({ name: '   ', url: 'https://example.invalid/only-one' });
		expect(errors.name).toContain('Name is required');
	});

	it('a blank url is still a field error on URL (pre-existing contract, not weakened)', () => {
		const errors = validateRepositoryForm({ name: 'something', url: '  ' });
		expect(errors.url).toBe('URL is required');
		expect(errors.name).toBe('');
	});

	it('blank url AND blank name reports BOTH fields', () => {
		const errors = validateRepositoryForm({ name: '', url: '' });
		expect(errors.url).toBe('URL is required');
		expect(errors.name).toContain('Name is required');
	});
});
