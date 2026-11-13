// tests/unit/kag-reviews-upstream.test.ts
//
// `EVIDENCE_REVIEW_URL` gives the `/reviews/*` surface its own upstream, and the
// thing that can silently go wrong is the PREFIX, not the host:
//
//   fr              /api/assets/kag/reviews/{rest}
//   via the gateway {kag}/reviews/{rest}   -> kag rewrites to {ers}/api/reviews/{rest}
//   direct          {ers}/api/reviews/{rest}
//
// Getting it wrong does not raise — Evidence Review answers a wrong prefix with a
// flat 404, so the studio shows empty reads and nothing anywhere names a
// misconfiguration. Every case below exists because it is one of the ways that
// 404 can be reached.
//
// `resolveReviewsTarget` is pure and exported precisely so these can be asserted
// without mutating `process.env` — a test that sets an env var to check a value
// captured at module load proves nothing, because `src/config.ts` reads
// `process.env` exactly once, when it is first imported.
import { describe, expect, test } from 'bun:test';

import { resolveReviewsTarget } from '../../src/routes/assets/kag-reviews';

const KAG = 'http://kag.example.com:8900';
const ERS = 'http://127.0.0.1:8810';

describe('resolveReviewsTarget', () => {
  test('unset — the kag gateway base is used, exactly as before', () => {
    // The production regression pin. If this ever changes, every deployed fr
    // stops talking to Evidence Review, and it does so on a path where a
    // wrong-but-plausible URL 404s rather than failing loudly.
    expect(
      resolveReviewsTarget('/api/assets/kag/reviews/r1/screening/queue', '?stage_id=s1', {
        evidenceReview: '',
        kag: KAG,
      }),
    ).toBe(`${KAG}/reviews/r1/screening/queue?stage_id=s1`);
  });

  test('unset — the bare collection path keeps its shape', () => {
    expect(resolveReviewsTarget('/api/assets/kag/reviews', '', { evidenceReview: '', kag: KAG })).toBe(
      `${KAG}/reviews`,
    );
  });

  test('set — the direct form carries the /api/reviews prefix the service mounts at', () => {
    // NOT a base swap. `${ERS}/reviews/...` — the shape a naive swap produces —
    // is a 404 at Evidence Review, which mounts its router at `/api/reviews`.
    expect(
      resolveReviewsTarget('/api/assets/kag/reviews/r1/screening/queue', '?stage_id=s1', {
        evidenceReview: ERS,
        kag: KAG,
      }),
    ).toBe(`${ERS}/api/reviews/r1/screening/queue?stage_id=s1`);
  });

  test('set — the bare collection path is /api/reviews with no trailing slash', () => {
    // The collection is where `listReviews` and `createReview` land, so a stray
    // trailing slash here breaks review creation specifically — the one call
    // whose failure looks most like an auth problem.
    expect(
      resolveReviewsTarget('/api/assets/kag/reviews', '', { evidenceReview: ERS, kag: KAG }),
    ).toBe(`${ERS}/api/reviews`);
  });

  test('set — the override wins over a configured gateway', () => {
    // Precedence is not incidental: a local stack has BOTH set, because the
    // backend still needs the gateway for every other kag surface.
    const target = resolveReviewsTarget('/api/assets/kag/reviews/r1', '', {
      evidenceReview: ERS,
      kag: KAG,
    });
    expect(target).toBe(`${ERS}/api/reviews/r1`);
    expect(target).not.toContain('8900');
  });

  test('trailing slashes on either base do not produce a doubled separator', () => {
    // `//api/reviews` is a different path from `/api/reviews` to a router, and
    // an operator pasting a URL with a trailing slash is the normal case.
    expect(
      resolveReviewsTarget('/api/assets/kag/reviews/r1', '', {
        evidenceReview: `${ERS}///`,
        kag: '',
      }),
    ).toBe(`${ERS}/api/reviews/r1`);
    expect(
      resolveReviewsTarget('/api/assets/kag/reviews/r1', '', {
        evidenceReview: '',
        kag: `${KAG}/`,
      }),
    ).toBe(`${KAG}/reviews/r1`);
  });

  test('neither configured — no target, so the caller can answer 503', () => {
    expect(resolveReviewsTarget('/api/assets/kag/reviews', '', { evidenceReview: '', kag: '' })).toBe(
      null,
    );
  });
});
