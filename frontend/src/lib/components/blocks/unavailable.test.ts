import { describe, it, expect } from 'vitest';
import { sourceLabel, deriveBlockLabel } from './unavailable';
import type { BlockMeta } from '$lib/types/read-model';

const meta = (over: Partial<BlockMeta>): BlockMeta => ({
  source: 'planka',
  fetched_at: '2026-07-08T00:00:00.000Z',
  available: false,
  ...over,
});

describe('sourceLabel', () => {
  it('maps known sources to friendly names', () => {
    expect(sourceLabel('planka')).toBe('Board (Planka)');
    expect(sourceLabel('worker-management')).toBe('Workers');
  });
  it('falls back to the raw source for unknown ones', () => {
    expect(sourceLabel('mystery-service')).toBe('mystery-service');
  });
});

describe('deriveBlockLabel', () => {
  it('reads as a transient failure when an error is present but no kind (legacy)', () => {
    expect(deriveBlockLabel(meta({ error: 'UPSTREAM_TIMEOUT: slow' }))).toBe(
      'Board (Planka) is temporarily unavailable.',
    );
  });
  it('reads as a data gap when there is no error or kind (legacy)', () => {
    expect(deriveBlockLabel(meta({ source: 'kag' }))).toBe(
      "Knowledge graph isn't reporting this yet.",
    );
  });
  it('treats a whitespace-only error as no error (legacy)', () => {
    expect(deriveBlockLabel(meta({ error: '   ' }))).toBe(
      "Board (Planka) isn't reporting this yet.",
    );
  });

  it("kind 'error' stays generic and never leaks the sanitized error text", () => {
    expect(
      deriveBlockLabel(meta({ unavailable_kind: 'error', error: 'UPSTREAM_TIMEOUT: slow' })),
    ).toBe('Board (Planka) is temporarily unavailable.');
  });
  it("kind 'no_selection' prompts a selection instead of an outage", () => {
    expect(
      deriveBlockLabel(meta({ unavailable_kind: 'no_selection', error: 'no card selected — pass ?card=' })),
    ).toBe('Select an item to view this.');
  });
  it("kind 'data_gap' renders the curated reason (capitalized), not 'temporarily unavailable'", () => {
    expect(
      deriveBlockLabel(
        meta({ source: 'n8n', unavailable_kind: 'data_gap', error: 'no n8n workflow linked to this card — data-gap register' }),
      ),
    ).toBe('No n8n workflow linked to this card — data-gap register');
  });
  it("kind 'no_data' renders the curated reason (capitalized)", () => {
    expect(
      deriveBlockLabel(
        meta({ source: 'metering', unavailable_kind: 'no_data', error: 'no kaizen record for this card' }),
      ),
    ).toBe('No kaizen record for this card');
  });
  it('falls back to a source-named line when a kind carries no reason', () => {
    expect(deriveBlockLabel(meta({ source: 'kag', unavailable_kind: 'data_gap' }))).toBe(
      "Knowledge graph isn't captured upstream yet.",
    );
    expect(deriveBlockLabel(meta({ source: 'kag', unavailable_kind: 'no_data' }))).toBe(
      'Knowledge graph has no data for this selection.',
    );
  });
});
