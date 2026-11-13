// src/services/approvals/handoff-contract.ts
//
// P2.3 (C1-59) — the handoff.v2 contract carried on an A3 (`execution.feature_design_approval`)
// mint as `metadata.handoff_contract`: "the A3 approval IS the sealed design".
//
// THE REFERENCE IS ncn `scripts/lib/handoff-contract.mjs` (handoff.v2, ncn#2034). This schema
// mirrors its STRUCTURE walk (`schemaPointer`) plus the per-field formats its `validateHandoff`
// enforces on a single unit (unit{kind,file,function,insert_after?}, canonical target_files,
// acceptance_tests[{id crit_<8hex>, path *.py, code}], 1..7 units, 1..7 ACs per unit). Every
// object is `.strict()`: an unknown key at ANY level is a loud 422, never a silent drop.
//
// NOT CHECKED HERE (they need the design H_d / the approval / the tenant's repo, i.e. ncn's ctx):
// cross-unit ownership, AC coverage against H_d, requires-graph acyclicity, write-set budget,
// repo visibility. ncn's validateHandoff runs those on the stored contract before any mint.
//
// THE HASH: contract_hash = sha256_hex(canonicalizeJcs(contract minus design_approval_id)).
// canonicalizeJcs is fr's ONE definition (src/lib/bug-report-hash.ts); ncn's `canonicalJson`
// is a line-for-line port, pinned by the shared known-answer vectors in
// tests/fixtures/handoff-v2/*.json (copied byte-identical from ncn). `design_approval_id` is
// EXCLUDED (ncn CONTRACT_HASH_EXCLUDED): it is the id fr assigns to the very approval whose
// metadata carries the hash, so including it would be circular.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalizeJcs } from '../../lib/bug-report-hash';

export const HANDOFF_CONTRACT_VERSION = 'handoff.v2' as const;
export const HANDOFF_UNIT_MIN = 1;
export const HANDOFF_UNIT_MAX = 7;
export const HANDOFF_UNIT_AC_MIN = 1;
export const HANDOFF_UNIT_AC_MAX = 7;
/** ncn CONTRACT_HASH_EXCLUDED. */
export const HANDOFF_CONTRACT_HASH_EXCLUDED = ['design_approval_id'] as const;
export const HANDOFF_FEATURE_DEV_TYPES = ['development_feature_new', 'development_feature_update'] as const;

// Postgres jsonb cannot store U+0000 in a string: refused here (422) rather than 500 at insert.
// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/;
const text = z.string().regex(NO_NUL, 'U+0000 is not storable');
const nonEmpty = text.min(1);

// Verbatim from ncn handoff-contract.mjs.
const CRIT_RE = /^crit_[0-9a-f]{8}$/;
const FUNC_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PATH_CHARSET_RE = /^[A-Za-z0-9_./-]+$/;
const TEST_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+\.py$/;

export function isCanonicalPath(p: string): boolean {
  return PATH_CHARSET_RE.test(p) && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const canonicalPath = z.string().refine(isCanonicalPath, {
  message: 'a canonical relative path ([A-Za-z0-9_./-] only, no leading /, no "", . or .. segment)',
});
const testPath = z
  .string()
  .refine((p) => TEST_PATH_RE.test(p) && isCanonicalPath(p), { message: 'a relative canonical .py path' });
const critId = z.string().regex(CRIT_RE, 'crit_<8 lowercase hex>');
const funcName = z.string().regex(FUNC_RE, 'ONE identifier, optionally dotted');

const HandoffUnitSpecSchema = z
  .object({
    kind: z.enum(['new', 'update']),
    file: canonicalPath,
    function: funcName,
    // OPTIONAL: absent or null = append (kind=new); ignored for kind=update.
    insert_after: funcName.nullable().optional(),
  })
  .strict();

const HandoffUnitSchema = z
  .object({
    unit_key: nonEmpty,
    unit: HandoffUnitSpecSchema,
    scope: z
      .object({
        summary: nonEmpty.max(280),
        target_files: z.array(canonicalPath).min(1),
        element_ids: z.array(nonEmpty),
      })
      .strict(),
    interfaces: z.array(
      z
        .object({
          direction: z.enum(['provides', 'consumes']),
          name: nonEmpty,
          signature: text,
        })
        .strict(),
    ),
    acceptance_criteria: z
      .array(z.object({ id: critId, text: nonEmpty }).strict())
      .min(HANDOFF_UNIT_AC_MIN)
      .max(HANDOFF_UNIT_AC_MAX),
    acceptance_tests: z
      .array(
        z
          .object({
            id: critId,
            path: testPath,
            code: text.refine((c) => c.trim().length > 0, { message: 'code must be non-blank' }),
          })
          .strict(),
      )
      .min(1),
    covers: z.array(nonEmpty),
    child_card_type: z.enum(HANDOFF_FEATURE_DEV_TYPES),
    requires: z.array(nonEmpty),
  })
  .strict();

export const HandoffContractSchema = z
  .object({
    contract_version: z.literal(HANDOFF_CONTRACT_VERSION),
    decomposition_id: nonEmpty,
    design_card_id: nonEmpty,
    producing_procedure: nonEmpty,
    design_hash: nonEmpty,
    // Optional at MINT: fr assigns the approval id, so a producer may not know it yet. Excluded
    // from the hash either way; ncn binds it to the triggering approval at validate time.
    design_approval_id: nonEmpty.optional(),
    repository_url: nonEmpty,
    branch: nonEmpty,
    container_name: nonEmpty,
    repo_name: nonEmpty,
    units: z.array(HandoffUnitSchema).min(HANDOFF_UNIT_MIN).max(HANDOFF_UNIT_MAX),
  })
  .strict();

export type HandoffContract = z.infer<typeof HandoffContractSchema>;

/**
 * sha256_hex(canonicalizeJcs(contract minus design_approval_id)) over UTF-8 — ncn `contractHash`.
 * Hashes the value AS GIVEN (callers pass the raw, validated object, never a re-built one).
 */
export function handoffContractHash(contract: Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...contract };
  for (const k of HANDOFF_CONTRACT_HASH_EXCLUDED) delete body[k];
  return createHash('sha256').update(canonicalizeJcs(body), 'utf8').digest('hex');
}
