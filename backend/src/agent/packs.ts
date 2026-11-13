/**
 * fr-agui SPEC §11.2 / §11.3 (P1) — fr's own in-repo capability packs.
 *
 * A pack is the `capability-pack/v1` shape: `capabilities.json` (the ids) +
 * `instructions.md` (the prompt). fr owns the schema. These two fr-authored packs ARE the agent's
 * catalogs — nothing else decides them:
 *
 *   request-intake  the doorway agent (SPEC §6.0)            → agent/intake-catalog.ts
 *   project-core    the project agent (SPEC §4.1, §8.1 P1)   → agui/agent-surface.ts
 *
 * `capabilities` are sent every turn (`tier:'core'`); `searchable` ones join a
 * thread's catalog only after `capabilities.search` returned them in that
 * thread (SPEC §4.1). A pack can never GRANT: the catalog is still the RBAC
 * dry-run of each member (agent/tool-catalog.ts).
 *
 * ⛔ Env-free and side-effect free at import: the JSON is a static import, and
 * the instructions are read lazily (only the agent loop renders them).
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import projectCoreJson from './packs/project-core/capabilities.json';
import requestIntakeJson from './packs/request-intake/capabilities.json';

const ID_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export const CapabilityPackSchema = z
  .object({
    schema: z.literal('capability-pack/v1'),
    consumer: z.literal('fr'),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.number().int().min(1),
    summary: z.string().min(1),
    capabilities: z.array(z.string().regex(ID_RE)).min(1),
    searchable: z.array(z.string().regex(ID_RE)),
    requires: z.object({ fr_registry: z.string().min(1) }),
    examples: z.array(z.object({ user: z.string().min(1), capabilities: z.array(z.string().regex(ID_RE)) })),
  })
  .strict()
  .superRefine((p, ctx) => {
    const all = [...p.capabilities, ...p.searchable];
    if (new Set(all).size !== all.length) ctx.addIssue({ code: 'custom', message: `pack ${p.id} lists an id twice` });
    for (const ex of p.examples) {
      for (const id of ex.capabilities) {
        if (!all.includes(id)) ctx.addIssue({ code: 'custom', message: `pack ${p.id} example names ${id}, not a member` });
      }
    }
  });

export type CapabilityPack = z.infer<typeof CapabilityPackSchema>;
export type FrPackId = 'project-core' | 'request-intake';

/** Parsed once at import; a malformed in-repo pack fails the boot (and every test importing it). */
export const FR_PACKS: Readonly<Record<FrPackId, CapabilityPack>> = Object.freeze({
  'project-core': CapabilityPackSchema.parse(projectCoreJson),
  'request-intake': CapabilityPackSchema.parse(requestIntakeJson),
});

/** Every member id (core ∪ searchable). */
export function packMembers(id: FrPackId): ReadonlySet<string> {
  const p = FR_PACKS[id];
  return new Set([...p.capabilities, ...p.searchable]);
}

/** The ids sent every turn. */
export function packCore(id: FrPackId): ReadonlySet<string> {
  return new Set(FR_PACKS[id].capabilities);
}

/** The ids offered only after `capabilities.search` returned them in the thread. */
export function packSearchable(id: FrPackId): ReadonlySet<string> {
  return new Set(FR_PACKS[id].searchable);
}

const instructionsCache = new Map<FrPackId, string>();

/** The pack's `instructions.md` (fr-authored; may take system position, SPEC §11.2). */
export function packInstructions(id: FrPackId): string {
  const hit = instructionsCache.get(id);
  if (hit !== undefined) return hit;
  const text = readFileSync(new URL(`./packs/${id}/instructions.md`, import.meta.url), 'utf8').trim();
  instructionsCache.set(id, text);
  return text;
}

/**
 * Read every pack's `instructions.md` once, at boot. A pack file missing from the
 * image (a `.dockerignore` `**\/*.md` rule did exactly that, 2026-10-27) must stop
 * the rollout, not surface as ENOENT on a user's first Copilot turn.
 */
export function assertPackInstructionsPresent(): void {
  for (const id of Object.keys(FR_PACKS) as FrPackId[]) {
    if (packInstructions(id).length === 0) throw new Error(`agent pack ${id}: instructions.md is empty`);
  }
}

/** The block the loop renders above the tool catalog (SPEC §11.2 "skill block"). */
export function renderPackBlock(id: FrPackId): string {
  const p = FR_PACKS[id];
  return `<skill id="fr/${p.id}" version="${p.version}" trust="fr-authored">\n${packInstructions(id)}\n</skill>`;
}
