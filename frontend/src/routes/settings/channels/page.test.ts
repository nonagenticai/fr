// src/routes/settings/channels/page.test.ts
//
// Unit tests for the masking helper used by the channels page.
// Component-level tests live alongside other pages (jsdom mounts); here we
// pin the per-channel masking rules so a regression in the rules is caught
// without spinning up the full DOM.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 5 Task 5.1.

import { describe, it, expect } from 'vitest';
import { maskAddress } from '$lib/api/channel-prefs';

describe('maskAddress', () => {
  describe('email / teams', () => {
    it('shows first letter of local part + full domain (email)', () => {
      expect(maskAddress('email', 'alice@example.com')).toBe('a••••@example.com');
    });
    it('shows first letter of local part + full domain (teams)', () => {
      expect(maskAddress('teams', 'bob@tenant.onmicrosoft.com')).toBe(
        'b••••@tenant.onmicrosoft.com',
      );
    });
    it('falls back to first-letter mask when address has no @', () => {
      expect(maskAddress('email', 'malformed')).toBe('m••••');
    });
  });

  describe('websocket', () => {
    it('shows first 6 chars + ellipsis for long ids', () => {
      expect(maskAddress('websocket', 'ws-abc123def456')).toBe('ws-abc…');
    });
    it('returns short ids unchanged', () => {
      expect(maskAddress('websocket', 'ws-1')).toBe('ws-1');
      expect(maskAddress('websocket', 'abcdef')).toBe('abcdef');
    });
  });

  it('returns empty string for empty input', () => {
    expect(maskAddress('email', '')).toBe('');
    expect(maskAddress('teams', '')).toBe('');
    expect(maskAddress('websocket', '')).toBe('');
  });
});
