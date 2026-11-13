#!/usr/bin/env bun
/**
 * tag-n8n-workflows.ts — assign the namespaced facet tag vocabulary to
 * every n8n workflow so fr's /workflows page can filter by domain /
 * purpose / stage / trigger.
 *
 *   bun run scripts/tag-n8n-workflows.ts                 # dry-run (default)
 *   bun run scripts/tag-n8n-workflows.ts --apply         # write changes
 *   bun run scripts/tag-n8n-workflows.ts --apply --prune-vestigial
 *
 * It is idempotent and re-runnable — safe to schedule (the repo's CI cron,
 * .github/workflows/tag-n8n-workflows.yml) keeps new workflows tagged as
 * the catalogue grows. Re-running with no catalogue change reports
 * "0 workflows changed".
 *
 * Classification is the SAME `lib/workflow-classify.ts` module the
 * `/api/workflows` route reads, so the tags written here and the facets
 * the route parses back can never drift.
 *
 * Ownership: the script owns exactly the `domain:` / `purpose:` / `stage:`
 * / `trigger:` tag namespaces. Any other tag on a workflow (manual /
 * plain) is preserved untouched. A stale owned tag from an earlier
 * misclassification IS removed, because it falls in an owned namespace and
 * is no longer in the desired set — that is what makes re-runs converge.
 *
 * Env (Bun auto-loads .env): N8N_API_URL, N8N_API_KEY. When run against
 * prod n8n, export them from the cluster first, e.g.
 *   export N8N_API_KEY=$(kubectl -n fr exec deploy/fr -c fr-backend -- \
 *     printenv N8N_API_KEY)
 *   export N8N_API_URL=https://n8n.example.com/api/v1
 *
 * The n8n generated service-client has no tag endpoints, so tag CRUD here
 * is raw fetch against /tags and /workflows/{id}/tags.
 */

import { computeFacetTags, parseFacetTag } from '../src/lib/workflow-classify';

// ---------------------------------------------------------------------------
// Config + flags
// ---------------------------------------------------------------------------

const API_URL = (process.env.N8N_API_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.N8N_API_KEY || '';
const APPLY = process.argv.includes('--apply');
const PRUNE_VESTIGIAL = process.argv.includes('--prune-vestigial');

/**
 * The five pre-existing un-namespaced tags on the n8n instance, none of
 * them assigned to any workflow (verified 2026-05-14). They collide
 * conceptually with the faceted vocabulary (`purpose:demo`, `domain:tools`,
 * `purpose:test-monitoring`). `--prune-vestigial` deletes them — but only
 * the ones still carried by zero workflows after the assignment pass, so a
 * tag a human has since put to use is never yanked out from under them.
 */
const VESTIGIAL_TAGS = ['demo', 'tools', 'crud', 'test', 'discovery'];

if (!API_URL || !API_KEY) {
  console.error(
    'N8N_API_URL and N8N_API_KEY must be set (Bun auto-loads .env). See the file header for the cluster export recipe.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// n8n Public API — raw tag + workflow client
// ---------------------------------------------------------------------------

const HEADERS = {
  'X-N8N-API-KEY': API_KEY,
  'content-type': 'application/json',
};

interface N8nTag {
  id: string;
  name: string;
}
interface N8nWorkflow {
  id: string;
  name?: string;
  tags?: Array<{ id: string; name: string }>;
  nodes?: Array<{ type?: unknown }>;
}

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`n8n ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  // DELETE returns an (often empty) body we don't need.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Cursor-follow a paginated n8n collection endpoint. */
async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ limit: '250' });
    if (cursor) qs.set('cursor', cursor);
    const page = await api<{ data: T[]; nextCursor: string | null }>(
      `${path}?${qs.toString()}`,
    );
    out.push(...(page.data ?? []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Workflow → desired tag set
// ---------------------------------------------------------------------------

function nodeTypesOf(w: N8nWorkflow): string[] {
  const types: string[] = [];
  for (const n of w.nodes ?? []) {
    if (n && typeof n === 'object' && typeof n.type === 'string') {
      types.push(n.type);
    }
  }
  return types;
}

/**
 * The final tag-name set a workflow SHOULD carry:
 *   (current tags NOT in an owned namespace)  ∪  computed facet tags
 * i.e. preserve every manual tag, replace the whole owned-namespace slice.
 */
function desiredTagNames(w: N8nWorkflow): string[] {
  const preserved = (w.tags ?? [])
    .map((t) => t.name)
    .filter((name) => parseFacetTag(name) === null);
  const facet = computeFacetTags(w.name ?? w.id, nodeTypesOf(w));
  return [...new Set([...preserved, ...facet])].sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `tag-n8n-workflows — ${APPLY ? 'APPLY' : 'DRY-RUN'}${
      PRUNE_VESTIGIAL ? ' --prune-vestigial' : ''
    }  (${API_URL})`,
  );

  const tags = await listAll<N8nTag>('/tags');
  const workflows = await listAll<N8nWorkflow>('/workflows');
  console.log(
    `Fetched ${tags.length} tags, ${workflows.length} workflows.\n`,
  );

  // name → id, kept current as we create missing tags.
  const tagId = new Map<string, string>();
  for (const t of tags) tagId.set(t.name, t.id);

  // 1. Create any facet tags that don't exist yet.
  const desiredPerWorkflow = new Map<string, string[]>();
  const allDesiredTagNames = new Set<string>();
  for (const w of workflows) {
    const desired = desiredTagNames(w);
    desiredPerWorkflow.set(w.id, desired);
    for (const name of desired) allDesiredTagNames.add(name);
  }
  const missingTags = [...allDesiredTagNames].filter((n) => !tagId.has(n)).sort();
  if (missingTags.length > 0) {
    console.log(`Tags to create (${missingTags.length}):`);
    for (const name of missingTags) console.log(`  + ${name}`);
    if (APPLY) {
      for (const name of missingTags) {
        const created = await api<N8nTag>('/tags', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        tagId.set(created.name, created.id);
      }
      console.log(`  ...created.\n`);
    } else {
      console.log('');
    }
  }

  // 2. Diff + (apply) PUT each workflow's tag set.
  let changed = 0;
  let unchanged = 0;
  for (const w of workflows) {
    const desired = desiredPerWorkflow.get(w.id)!;
    const current = (w.tags ?? []).map((t) => t.name).sort();
    const desiredSet = new Set(desired);
    const currentSet = new Set(current);
    const added = desired.filter((n) => !currentSet.has(n));
    const removed = current.filter((n) => !desiredSet.has(n));

    if (added.length === 0 && removed.length === 0) {
      unchanged += 1;
      continue;
    }
    changed += 1;
    const diff = [
      ...added.map((n) => `+${n}`),
      ...removed.map((n) => `-${n}`),
    ].join(' ');
    console.log(`  ~ ${w.id}  "${w.name ?? w.id}"`);
    console.log(`      ${diff}`);

    if (APPLY) {
      const ids = desired.map((name) => {
        const id = tagId.get(name);
        if (!id) throw new Error(`No id for tag "${name}" — create step missed it`);
        return { id };
      });
      await api(`/workflows/${encodeURIComponent(w.id)}/tags`, {
        method: 'PUT',
        body: JSON.stringify(ids),
      });
    }
  }

  console.log(
    `\n${changed} workflow${changed === 1 ? '' : 's'} ${
      APPLY ? 'updated' : 'would change'
    }, ${unchanged} unchanged.`,
  );

  // 3. Prune vestigial un-namespaced tags that no workflow carries.
  if (PRUNE_VESTIGIAL) {
    const assignedNames = new Set<string>();
    for (const w of workflows) {
      for (const t of w.tags ?? []) assignedNames.add(t.name);
    }
    const prunable = VESTIGIAL_TAGS.filter(
      (name) => tagId.has(name) && !assignedNames.has(name),
    );
    if (prunable.length === 0) {
      console.log('\nNo prunable vestigial tags (none exist, or all in use).');
    } else {
      console.log(`\nVestigial tags to delete (${prunable.length}):`);
      for (const name of prunable) console.log(`  - ${name}`);
      if (APPLY) {
        for (const name of prunable) {
          await api(`/tags/${tagId.get(name)!}`, { method: 'DELETE' });
        }
        console.log('  ...deleted.');
      }
    }
  }

  if (!APPLY) {
    console.log('\nDry-run — no changes written. Re-run with --apply to commit.');
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
