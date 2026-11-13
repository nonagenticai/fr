// /library/conveyor/catalogue — 308 to a section route (no tab strip in a page).
import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(url: string): { status?: number; location?: string } {
  try {
    load({ url: new URL(url, 'http://fr.test') } as never);
    return {};
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('/library/conveyor/catalogue redirect', () => {
  it('goes to the first section by default', () => {
    expect(redirectOf('/library/conveyor/catalogue')).toEqual(
      expect.objectContaining({ status: 308, location: '/library/conveyor/catalogue/phases' }),
    );
  });

  it('honours ?tab=<section> and drops it', () => {
    expect(redirectOf('/library/conveyor/catalogue?tab=card-types&capability_id=c').location).toBe(
      '/library/conveyor/catalogue/card-types?capability_id=c',
    );
    expect(redirectOf('/library/conveyor/catalogue?tab=nope').location).toBe('/library/conveyor/catalogue/phases');
  });
});
