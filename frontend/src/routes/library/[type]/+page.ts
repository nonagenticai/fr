import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Governance assets (requirements / principles / decisions) are
// now listed canonically at the top-level `/{plural}` routes (AssetWorkspace),
// which carry the scope/promote features inline. The old `/library/<type>`
// tenancy lens for them is removed — redirect both singular and plural slugs to
// the canonical surface so old links keep working.
//
// The lens stays alive for the kinds that have no canonical top-level home:
// kag_document, workflow (rich list = /workflows), channel (registry =
// /channels), trigger.
//
// ⚠️ THIS REDIRECT IS WHY THE LENS NEEDS NO PAGE-CAP SIGNAL — measured
// 2026-09-06, after I had already built one for it and had to take it out.
// The four kinds that still land on `+page.svelte` are exactly the four whose
// routes emit no `X-Truncated` / `X-Applied-Limit`: kag-documents is
// deliberately uncapped (its upstream drops `limit` one hop down), and
// workflows / channels / triggers are uncapped too. So a truncation banner on
// that page can never render — it would be machinery with no live caller.
// The governance kinds, which ARE capped, never reach it: they 308 away to
// AssetWorkspace, whose own `asset-list-truncated` banner is live in
// production and does the job.
//
// If one of those four ever gains a cap, add the banner then — and check
// this list first, because the surface a governance slug reaches is NOT the
// file the slug names.
const GOVERNANCE_TO_PLURAL: Record<string, string> = {
  requirement: 'requirements',
  requirements: 'requirements',
  principle: 'principles',
  principles: 'principles',
  decision: 'decisions',
  decisions: 'decisions',
};

export const load: PageLoad = ({ params }) => {
  const dest = GOVERNANCE_TO_PLURAL[params.type ?? ''];
  if (dest) throw redirect(308, `/${dest}`);
  return {};
};
