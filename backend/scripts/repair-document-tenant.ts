// Repair script: set `documents.tenant_id` on legacy rows so they become deletable again.
//
// Why this exists: `documents.tenant_id` (migration 083) records the tenant a document's KAG
// data was ingested under. Rows created BEFORE 083 have it NULL. The delete path now REFUSES
// to purge such a row (409) rather than guessing a tenant — because purging under the wrong
// tenant deletes nothing downstream (the DELETE is tenant-scoped and idempotent: zero counts,
// HTTP 200) while looking like success, which silently orphans the document's PHI. Refusing is
// correct, but it leaves those rows undeletable until the real tenant is restored. This script
// restores it.
//
// Why the tenant must be supplied EXPLICITLY and is never inferred: fr cannot derive it.
//   * `user_roles` gives the user's tenant TODAY, which is not necessarily the tenant they
//     uploaded under — a super-admin can deliberately upload into another workspace via
//     `X-Active-Tenant`, and a user's tenant can change over time. Both happened in prod.
//   * A user with no `tenant_id` claim becomes their own tenant (`deriveTenantId` falls back to
//     `sub`), so their documents sit under a tenant equal to their user id.
// Guessing would write a WRONG tenant, and the delete would then confidently purge nothing.
//
// The ground truth is the tenant the chunks are actually filed under, which only the graph
// store knows. Get it there, then pass it in:
//
//   psql -d kag_graph -c \
//     "SELECT doc_id, tenant_id, count(*) FROM chunks WHERE doc_id = '<kag_ingestion_id>' GROUP BY 1,2;"
//
// A document with NO chunks under any tenant has no downstream footprint at all; give it any
// tenant you own (its purge is a no-op by definition) or leave it — this script only refuses to
// invent one.
//
// SAFETY: dry-run by DEFAULT — it only reports. Pass --apply to write. Only ever fills a NULL;
// it will never overwrite a tenant that is already recorded.
//
// Usage (run inside the fr-backend pod, which carries DATABASE_URL):
//   bun run scripts/repair-document-tenant.ts --map <documentId>=<tenantId> [--map ...]
//   bun run scripts/repair-document-tenant.ts --map <documentId>=<tenantId> --apply

import { and, eq, isNull } from 'drizzle-orm';
import { closeConnection, db, documents } from '../src/db/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMappings(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--map') continue;
    const pair = argv[i + 1];
    if (!pair) throw new Error('--map requires <documentId>=<tenantId>');
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`malformed --map "${pair}" (want <documentId>=<tenantId>)`);
    const documentId = pair.slice(0, eq).trim();
    const tenantId = pair.slice(eq + 1).trim();
    // Both are uuid columns; a malformed value would otherwise fail deep inside the driver.
    if (!UUID_RE.test(documentId)) throw new Error(`not a uuid document id: "${documentId}"`);
    if (!UUID_RE.test(tenantId)) throw new Error(`not a uuid tenant id: "${tenantId}"`);
    map.set(documentId, tenantId);
  }
  return map;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mappings = parseMappings(process.argv.slice(2));

  if (mappings.size === 0) {
    console.error(
      'No --map given. Usage:\n' +
        '  bun run scripts/repair-document-tenant.ts --map <documentId>=<tenantId> [--apply]\n\n' +
        'Find the true tenant in the graph store (see the header of this file):\n' +
        "  psql -d kag_graph -c \"SELECT doc_id, tenant_id, count(*) FROM chunks WHERE doc_id = '<kag_ingestion_id>' GROUP BY 1,2;\"",
    );
    process.exit(1);
  }

  console.log(
    `[repair-tenant] mode: ${apply ? 'APPLY (will write tenant_id)' : 'DRY-RUN (report only)'}`,
  );

  let written = 0;
  let skipped = 0;

  for (const [documentId, tenantId] of mappings) {
    const [row] = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        tenant_id: documents.tenant_id,
        kag_ingestion_id: documents.kag_ingestion_id,
        kag_document_id: documents.kag_document_id,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!row) {
      console.error(`[repair-tenant] SKIP ${documentId}: no such document`);
      skipped++;
      continue;
    }
    if (row.tenant_id) {
      // Never overwrite a recorded tenant — that value IS the ingest truth, and replacing it
      // would recreate exactly the mismatch this whole change exists to prevent.
      console.error(
        `[repair-tenant] SKIP ${documentId}: tenant already recorded (${row.tenant_id}) — refusing to overwrite`,
      );
      skipped++;
      continue;
    }

    const purgeKey = row.kag_document_id ?? row.kag_ingestion_id ?? '(none)';
    console.log(
      `[repair-tenant] ${apply ? 'WRITE' : 'would write'} ${documentId} ("${row.filename}") ` +
        `tenant_id=${tenantId}  [purge key: ${purgeKey}]`,
    );

    if (apply) {
      await db
        .update(documents)
        .set({ tenant_id: tenantId, updated_at: new Date() })
        // Re-assert the NULL guard: never race a concurrent write that recorded a real tenant.
        .where(and(eq(documents.id, documentId), isNull(documents.tenant_id)));
      written++;
    }
  }

  if (!apply) {
    console.log(`[repair-tenant] DRY-RUN — nothing written. Re-run with --apply.`);
    return;
  }
  console.log(`[repair-tenant] wrote tenant_id on ${written} row(s); skipped ${skipped}.`);
  console.log(
    '[repair-tenant] Verify the purge now has an effect: delete the document and confirm the ' +
      'response reports non-zero chunks_deleted (and that kag_graph.chunks for its doc_id is empty).',
  );
}

main()
  .catch((err) => {
    console.error('[repair-tenant] FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await closeConnection();
  });
