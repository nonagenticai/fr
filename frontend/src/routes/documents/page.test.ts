// /documents +page.ts — superseded by /library/kag/documents (same
// DocumentUploadPanel); 308 so bookmarks keep working.
import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(): { status?: number; location?: string } {
  try {
    const res = load({} as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('/documents +page.ts redirect', () => {
  it('308-redirects to /library/kag/documents', () => {
    const r = redirectOf();
    expect(r.status).toBe(308);
    expect(r.location).toBe('/library/kag/documents');
  });
});
