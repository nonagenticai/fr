// Phase 4 — backfill script for channels.credentials_enc.
//
// Encrypts every legacy-plaintext row in `channels` to the AES-GCM
// envelope shape `{v:1, iv, ct}` (base64-of-JSON). Idempotent:
// already-encrypted rows are detected via the base64 envelope prefix
// and skipped.
//
// Usage:
//   bun run scripts/encrypt-channel-credentials.ts --dry-run   # report only
//   bun run scripts/encrypt-channel-credentials.ts             # encrypt in place
//
// Per memory `feedback-credentials-connectivity.md`, run this against
// real data via `kubectl exec` into a job pod, NOT from a laptop. The
// script connects to whatever $DATABASE_URL points at — make sure
// you're connected to the right cluster.
//
// Selection clause:
//   WHERE credentials_enc IS NOT NULL
//     AND credentials_enc NOT LIKE 'eyJ2Ijox%'
//
// `eyJ2Ijox` is base64 of `{"v":1` and is the deterministic prefix of
// every envelope value emitted by `encryption.encryptToEnvelope`.

import postgres from 'postgres';
import { encryption } from '../src/services/encryption';

const ENVELOPE_PREFIX = 'eyJ2Ijox';
const BATCH_SIZE = 100;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[encrypt-channel-credentials] DATABASE_URL is required');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  await encryption.initialize();

  const sql = postgres(url, { max: 2, onnotice: () => {} });
  let total = 0;
  let encrypted = 0;
  let skipped = 0;

  try {
    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM channels
      WHERE credentials_enc IS NOT NULL
        AND credentials_enc NOT LIKE ${ENVELOPE_PREFIX + '%'}
    `;
    total = Number.parseInt(countRows[0]?.count ?? '0', 10);
    console.log(
      `[encrypt-channel-credentials] ${dryRun ? '[DRY RUN] ' : ''}` +
        `${total} legacy-plaintext row(s) to encrypt`,
    );

    if (dryRun || total === 0) {
      return;
    }

    // Batch-iterate by id ordering so we always converge — once a row is
    // encrypted it no longer matches the LIKE clause, but we filter by
    // the same predicate on each batch query to stay idempotent under
    // concurrent writes.
    while (true) {
      const rows = await sql<{ id: string; credentials_enc: string }[]>`
        SELECT id, credentials_enc
        FROM channels
        WHERE credentials_enc IS NOT NULL
          AND credentials_enc NOT LIKE ${ENVELOPE_PREFIX + '%'}
        ORDER BY id
        LIMIT ${BATCH_SIZE}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        // Defensive double-check — if another process raced us and
        // already encrypted this row, skip it.
        if (row.credentials_enc.startsWith(ENVELOPE_PREFIX)) {
          skipped += 1;
          continue;
        }
        const envelope = await encryption.encryptToEnvelope(row.credentials_enc);
        await sql`
          UPDATE channels
          SET credentials_enc = ${envelope}
          WHERE id = ${row.id}
            AND credentials_enc = ${row.credentials_enc}
        `;
        encrypted += 1;
      }
    }
    console.log(
      `[encrypt-channel-credentials] done: encrypted=${encrypted}, skipped=${skipped}, total=${total}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
