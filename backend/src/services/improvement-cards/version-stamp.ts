// Card version stamps (C1-46, migration 140 `card_version_stamps`).
//
// POST /api/cards/project accepts an optional `version_stamp` object on CREATE.
// The FULL stamp is stored in fr (one row per Planka card id); the card carries
// only a small pointer in `Metadata.version_stamp`:
//
//     {"store":"fr","sha256":"<64 lowercase hex>"}      (~87 chars)
//
// where sha256 is over the CANONICAL JSON of the stamp (object keys sorted
// recursively, array order kept) — the same canonicalisation the procedure
// config hash uses, so two semantically equal stamps hash identically.
// GET /api/cards/:id returns the full stamp from the table.

import { createHash } from 'node:crypto';

import { queryClient } from '../../db/client';
import { canonicalJson } from '../improvement/config-hash';

/**
 * Hard ceiling on the serialised pointer written to the Planka field. The
 * pointer cannot exceed it by construction (a fixed key set plus a 64-char
 * hex digest); the check is a guard so a future change to the pointer shape
 * fails as a 422 instead of writing an unbounded value into a Planka cell.
 */
export const VERSION_STAMP_POINTER_MAX_CHARS = 512;

/**
 * Hard ceiling on the SERIALISED stamp (UTF-8 bytes of `JSON.stringify`), so a
 * single create cannot write an unbounded JSONB row into `card_version_stamps`.
 * 64 KiB — the same figure fr uses for client-error bodies
 * (`MAX_BODY_BYTES` in routes/client-errors.ts). Deliberately declared here
 * rather than imported: a service must not depend on a route module, and the
 * two caps are independent (raising one must not move the other).
 */
export const VERSION_STAMP_MAX_BYTES = 64 * 1024;

export type VersionStamp = Record<string, unknown>;

/** UTF-8 byte length of the serialised stamp — the quantity the cap bounds. */
export function versionStampSerialisedBytes(stamp: VersionStamp): number {
  return Buffer.byteLength(JSON.stringify(stamp), 'utf8');
}

/** Lowercase hex sha256 of the canonical JSON of `stamp`. */
export function versionStampSha256(stamp: VersionStamp): string {
  return createHash('sha256').update(canonicalJson(stamp)).digest('hex');
}

/** The serialised pointer written to `Metadata.version_stamp`. */
export function buildVersionStampPointer(sha256: string): string {
  return JSON.stringify({ store: 'fr', sha256 });
}

/**
 * Insert the stamp row for a NEW card. ON CONFLICT (card_id) DO NOTHING — the
 * first stamp for a card wins. Returns true when THIS call inserted the row
 * (the caller then owns deleting it if the create is rolled back).
 *
 * ⛔ Refuses an empty card id: only a create that returned a real Planka card
 * id may write a row. (The CHECK in migration 140 refuses it too.)
 */
export async function insertVersionStamp(args: {
  cardId: string;
  projectId: string;
  stamp: VersionStamp;
  sha256: string;
}): Promise<boolean> {
  if (typeof args.cardId !== 'string' || args.cardId.length === 0) {
    throw new Error('insertVersionStamp: refusing to write a stamp without a real card_id');
  }
  const rows = await queryClient`
    INSERT INTO card_version_stamps (card_id, project_id, stamp, stamp_sha256)
    VALUES (
      ${args.cardId}::text,
      ${args.projectId}::uuid,
      ${JSON.stringify(args.stamp)}::jsonb,
      ${args.sha256}::text
    )
    ON CONFLICT (card_id) DO NOTHING
    RETURNING card_id
  `;
  return rows.length > 0;
}

/** Delete the stamp row for a rolled-back card. Returns the rows removed. */
export async function deleteVersionStamp(cardId: string): Promise<number> {
  const rows = await queryClient`
    DELETE FROM card_version_stamps WHERE card_id = ${cardId}::text RETURNING card_id
  `;
  return rows.length;
}

/** The full stamp for a card, or null when the card has none. */
export async function loadVersionStamp(cardId: string): Promise<VersionStamp | null> {
  const rows = await queryClient<{ stamp: VersionStamp }[]>`
    SELECT stamp FROM card_version_stamps WHERE card_id = ${cardId}::text
  `;
  return rows[0]?.stamp ?? null;
}
