// src/services/decomposition/family-bundles.ts
//
// The frozen family context bundle (split-coherence-design.md §2.1, §5;
// migration 128 `family_bundles`). The parent's READY builds it once; the result
// is "frozen as family_bundles v1, bundle_hash=…" (design §7), and only
// "v<version>:<bundle_hash[0:16]>" goes onto the card.
//
// ⭐ FROZEN MEANS WRITE-ONCE PER VERSION. There is no update path. A second PUT
// of an existing version is:
//   · the SAME bundle_hash      → `unchanged` (an idempotent retry; nothing written)
//   · a DIFFERENT bundle_hash   → `conflict`  (refused — rewriting a version would
//                                  make every inference that recorded
//                                  (bundle_hash, decision_watermark) irreproducible,
//                                  which is the whole point of the bundle)
// A changed bundle is a NEW version.
//
// The insert is ON CONFLICT DO NOTHING on the (family_id, version) primary key,
// so two concurrent writers of one version cannot both succeed.

import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db/client';
import { familyBundles } from '../../db/schema';

export interface PutFamilyBundleInput {
  familyId: string;
  version: number;
  bundleHash: string;
  items: unknown;
  retrievalTrace?: unknown;
}

export type PutFamilyBundleResult =
  | { outcome: 'created'; version: number; bundle_hash: string }
  | { outcome: 'unchanged'; version: number; bundle_hash: string }
  | { outcome: 'conflict'; version: number; existing_bundle_hash: string };

export async function putFamilyBundle(input: PutFamilyBundleInput): Promise<PutFamilyBundleResult> {
  const inserted = await db
    .insert(familyBundles)
    .values({
      family_id: input.familyId,
      version: input.version,
      bundle_hash: input.bundleHash,
      items: input.items,
      retrieval_trace: input.retrievalTrace ?? {},
    })
    .onConflictDoNothing()
    .returning({ version: familyBundles.version, bundle_hash: familyBundles.bundle_hash });

  if (inserted.length === 1) {
    return { outcome: 'created', version: inserted[0]!.version, bundle_hash: inserted[0]!.bundle_hash };
  }

  const existing = await db
    .select({ bundle_hash: familyBundles.bundle_hash })
    .from(familyBundles)
    .where(and(eq(familyBundles.family_id, input.familyId), eq(familyBundles.version, input.version)))
    .limit(1);
  const hash = existing[0]?.bundle_hash;
  if (hash === undefined) {
    // The PK conflicted, so the row existed an instant ago; there is no delete
    // path besides the family's own cascade. Say so rather than guess.
    throw new Error(
      `putFamilyBundle: version ${input.version} of family ${input.familyId} conflicted but is no longer readable`,
    );
  }
  return hash === input.bundleHash
    ? { outcome: 'unchanged', version: input.version, bundle_hash: hash }
    : { outcome: 'conflict', version: input.version, existing_bundle_hash: hash };
}

export interface FamilyBundleRow {
  version: number;
  bundle_hash: string;
  items: unknown;
  retrieval_trace: unknown;
  created_at: Date;
}

/** A specific version, or the LATEST when `version` is omitted. null = none. */
export async function getFamilyBundle(
  familyId: string,
  version?: number,
): Promise<FamilyBundleRow | null> {
  const cols = {
    version: familyBundles.version,
    bundle_hash: familyBundles.bundle_hash,
    items: familyBundles.items,
    retrieval_trace: familyBundles.retrieval_trace,
    created_at: familyBundles.created_at,
  };
  const rows =
    version === undefined
      ? await db
          .select(cols)
          .from(familyBundles)
          .where(eq(familyBundles.family_id, familyId))
          .orderBy(desc(familyBundles.version))
          .limit(1)
      : await db
          .select(cols)
          .from(familyBundles)
          .where(and(eq(familyBundles.family_id, familyId), eq(familyBundles.version, version)))
          .limit(1);
  return rows[0] ?? null;
}
