/**
 * Zod schemas of the KAG ingestion tool surface (`/api/tools/kag/*`): the
 * AG-UI `kag.*` action inputs/outputs AND the route bodies.
 *
 * ⛔ SIDE-EFFECT FREE (zod only). Moved verbatim out of `routes/tools/kag.ts`
 * so the SAME schema objects are what `invokeAction` validates with and what
 * the capability declarations (src/capabilities/kag/tools.ts) derive their
 * OpenAPI operations from — one schema, never two that can disagree (fr-agui
 * SPEC §3.4, fr#1383). `routes/tools/kag.ts` registers the AG-UI actions at
 * module load, which a declaration may not import (src/capabilities/define.ts).
 *
 * The async-upload byte cap (`uploadAsyncInput`) stays in routes/tools/kag.ts:
 * its refine needs services/kag-upload-record (db).
 */
import { z } from 'zod';

export const passthrough = z.unknown();

// upload (async + sync) — file delivered base64 inside JSON for AG-UI/route uniformity.
export const uploadInput = z.object({
  file_b64: z.string().min(1),
  filename: z.string().min(1),
  content_type: z.string().optional(),
  send_to_kag: z.boolean().optional(),
});
export const uploadOutput = z.object({
  job_id: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

export const uploadSyncInput = uploadInput.extend({
  extract_images: z.boolean().optional(),
});

// scrape url
export const authConfigSchema = z
  .object({
    type: z.string().optional(),
    // ⛔ NOT `.uuid()`, deliberately — verified 2026-09-03. The id is minted by
    // the SECRETS service (`models.py:57`, `String(36)` defaulting to a uuid7
    // today) but its CONTRACT everywhere downstream is an opaque string: the
    // secrets API declares `credential_id: str` on every route and never
    // coerces it, and kag's consumer pins exactly the shape below —
    // `webscraper_service/src/schemas/scrape.py:109` is
    // `str, min_length=1, max_length=256, pattern=SAFE_STRING_PATTERN`, i.e.
    // "any control-character-free string". `min(1).max(256)` MIRRORS that
    // upstream constraint; narrowing it here would make fr stricter than the
    // service it calls and break the first non-uuid7 credential backend.
    credential_id: z.string().min(1).max(256),
    login_url: z.string().nullable().optional(),
    username_selector: z.string().nullable().optional(),
    password_selector: z.string().nullable().optional(),
    submit_selector: z.string().nullable().optional(),
    wait_for_url: z.string().nullable().optional(),
    wait_for_selector: z.string().nullable().optional(),
    wait_timeout_ms: z.number().int().min(1000).max(120000).optional(),
  })
  .passthrough();

export const scrapeUrlInput = z
  .object({
    url: z.string().min(1).max(2083),
    scraper_type: z.string().optional(),
    delay: z.number().min(0).optional(),
    timeout: z.number().min(1).optional(),
    screenshot: z.boolean().optional(),
    download_images: z.boolean().optional(),
    follow_links: z.boolean().optional(),
    max_depth: z.number().int().min(1).optional(),
    respect_robots_txt: z.boolean().optional(),
    user_agent: z.string().nullable().optional(),
    auth_config: authConfigSchema.nullable().optional(),
  })
  .passthrough();

// Bulk scrape: many URLs as one source. auth_config scrapes the whole batch behind
// ONE login (persisted + refreshable via ingestion); send_to_kag ingests each page.
export const scrapeBulkInput = z
  .object({
    urls: z.array(z.string().min(1).max(2083)).min(1).max(1000),
    scraper_type: z.string().optional(),
    send_to_kag: z.boolean().optional(),
    delay: z.number().min(0).optional(),
    timeout: z.number().min(1).optional(),
    auth_config: authConfigSchema.nullable().optional(),
  })
  .passthrough();
export const sessionIdOutput = z.object({ session_id: z.string().optional() }).passthrough();

// refresh-from-source: re-scrape a known source URL, re-ingest only if changed.
// No auth_config — MVP refreshes public sources (authenticated-source refresh is
// a follow-up that would thread the credential path like scrape_url).
export const scrapeRefreshInput = z
  .object({
    url: z.string().min(1).max(2083),
    send_to_kag: z.boolean().optional(),
    scraper_type: z.string().optional(),
    timeout: z.number().min(1).optional(),
    screenshot: z.boolean().optional(),
    download_images: z.boolean().optional(),
    user_agent: z.string().nullable().optional(),
  })
  .passthrough();
export const scrapeRefreshOutput = z
  .object({
    changed: z.boolean(),
    reingested: z.boolean(),
    session_id: z.string().optional(),
  })
  .passthrough();

// scrape sitemap
export const scrapeSitemapInput = z
  .object({
    sitemap_url: z.string().min(1).max(2083),
    max_urls: z.number().int().nullable().optional(),
    send_to_kag: z.boolean().optional(),
    delay: z.number().min(0).optional(),
    timeout: z.number().min(1).optional(),
    screenshot: z.boolean().optional(),
    download_images: z.boolean().optional(),
    respect_robots_txt: z.boolean().optional(),
    allowed_domains: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

// Multi-page (sitemap/crawl/bulk) source refresh.
export const refreshSourceInput = z.object({
  base_url: z.string().min(1).max(2083),
  session_type: z.enum(['sitemap', 'crawl', 'bulk']),
});
export const refreshSourceOutput = z
  .object({
    success: z.boolean(),
    session_id: z.string().optional(),
    urls_queued: z.number().optional(),
  })
  .passthrough();

// list sessions
export const listSessionsInput = z
  .object({
    status: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strip();

// id-only inputs
//
// ⚠️ `.uuid()` HERE IS PER-FIELD AND MEASURED, NOT A HOUSE STYLE. These inputs
// are agent-callable, so the value is whatever a model decided to type; a
// shape check is the only thing between a hallucinated id and the downstream.
// But the four id fields on this surface do NOT share one id-space, and
// tightening the wrong one rejects every real caller. Verified 2026-09-03
// against the services that MINT and CONSUME each id:
//
//   • session_id — UUID. `ingestion_service/src/models/database.py:356`
//     declares `session_id = Column(UUID(as_uuid=True), primary_key=True,
//     default=uuid7)`, and every terminal handler HARD-PARSES it:
//     `scraping_routes/sessions.py:129` filters on `UUID(session_id)` with an
//     explicit `except ValueError → 400 "Invalid session ID"` at :218. A
//     non-UUID is already a guaranteed 400 downstream — checking here turns a
//     round-trip into an immediate, better-worded rejection. ✅ tightened.
//
//   • job_id — UUID **on the routes these two actions reach**. `jobIdInput`
//     serves only `kag.list_document_images` and `kag.get_document_job`, whose
//     handlers resolve to the INGESTION path `/ingest/documents/jobs/{id}`
//     (`service-client-kag` `getGetDocumentJobStatusUrl`), backed by
//     `ingestion_jobs.job_id UUID` (`database.py:123`). The SQL compares a bare
//     string against that uuid column with no cast guard, so a non-UUID is a
//     Postgres `InvalidTextRepresentation` → 500, not a 404 — the repo says so
//     itself at `job_repository.py:744` and `batch_routes.py:333`. ✅ tightened.
//     ⛔ DO NOT copy this to a future orchestrator job action. kag_orchestrator
//     `orchestrator_service.py:626 _resolve_job` tries `UUID(job_id)` and, on
//     ValueError, FALLS BACK to a plain-string `external_id` lookup
//     (`models.py:61`, `String(255)`). `/kag/ingest/{id}` therefore accepts a
//     non-UUID by design; `.uuid()` on a tool wired to it would break it.
//
//   • batch_id — NEVER a UUID, so `.uuid()` is deliberately ABSENT. Minted as
//     `f"batch-{uuid.uuid7().hex[:12]}"` (`batch_routes.py:123`) — a prefix
//     plus a TRUNCATED stem, unparseable by any UUID parser — and consumed as
//     text out of JSONB (`IngestionJob.result["batch_id"].astext == batch_id`,
//     `batch_routes.py:469/616`). Adding `.uuid()` would reject 100% of real
//     batch ids and break `kag.retry_failed_batch_jobs` outright. ⛔ left as-is.
//
// (`auth_config.credential_id` is likewise left opaque — see the note on
// `authConfigSchema` above.)
export const sessionIdInput = z.object({ session_id: z.string().uuid() });
export const jobIdInput = z.object({ job_id: z.string().uuid() });
export const batchIdInput = z.object({ batch_id: z.string().min(1) });
