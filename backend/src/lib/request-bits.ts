// src/lib/request-bits.ts
//
// U-PS-S0 (fr half) — the DISCRIMINATING request bits a template start selects on
// (PSD §6.3 step 2; pm `src/utils/template_predicates.py` REQUEST_BITS — a closed set:
// three presence bits + the computed `repo_count`. "Adding a bit is a code change here AND
// in fr's S0" — the parity is pinned by tests/unit/lib/request-bits.test.ts).
//
// Each presence bit carries its `bit_source`:
//   form      — the requester filled a structured field; the bit is "field non-empty".
//   extracted — ncn's S0 worker (E18): 3 samples, set only on 3-of-3 unanimity + cited span.
//   unknown   — a sample disagreement / missing span, or never assessed ⇒ `value: null`, and
//               the start asks the requester instead of computing a template (§6.3 step 3-4).
// value NULL ⇔ bit_source 'unknown' — so "unknown" is always representable and never confused
// with "no".
//
// fr STORES, VALIDATES and EXPOSES (project_requests.request_bits, migration 170). The
// extraction itself is ncn's. `repo_count` is never stored: {@link requestBitVector} computes
// it from the request's repo list on read, so it cannot drift from the repos.

import { z } from 'zod';

/** The three stored presence bits (pm REQUEST_BITS minus the computed repo_count). */
export const PRESENCE_BITS = ['has_feature_statement', 'has_interface_contract', 'has_bdd_ac'] as const;
export type PresenceBit = (typeof PRESENCE_BITS)[number];

export const BIT_SOURCES = ['form', 'extracted', 'unknown'] as const;
export type BitSource = (typeof BIT_SOURCES)[number];

export const PresenceBitValueSchema = z
  .object({
    value: z.boolean().nullable(),
    bit_source: z.enum(BIT_SOURCES),
  })
  .strict()
  .refine((b) => (b.value === null) === (b.bit_source === 'unknown'), {
    message: "value is null exactly when bit_source is 'unknown'",
  });
export type PresenceBitValue = z.infer<typeof PresenceBitValueSchema>;

/** The stored shape: any subset of the three bits (an absent bit reads as unknown). Strict: no other key. */
export const StoredRequestBitsSchema = z
  .object({
    has_feature_statement: PresenceBitValueSchema.optional(),
    has_interface_contract: PresenceBitValueSchema.optional(),
    has_bdd_ac: PresenceBitValueSchema.optional(),
  })
  .strict();
export type StoredRequestBits = z.infer<typeof StoredRequestBitsSchema>;

/**
 * What a REQUESTER (UI form / user API) may write: only `form` or `unknown`. `extracted` is a
 * claim that ncn's 3-of-3 extraction ran — a human or API client cannot make it.
 */
export const RequesterRequestBitsSchema = StoredRequestBitsSchema.superRefine((bits, ctx) => {
  for (const name of PRESENCE_BITS) {
    if (bits[name]?.bit_source === 'extracted') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name, 'bit_source'],
        message: "a requester may set bit_source 'form' or 'unknown'; 'extracted' is written only by the S0 extraction",
      });
    }
  }
});

export const UNKNOWN_BIT: PresenceBitValue = Object.freeze({ value: null, bit_source: 'unknown' as const });

export interface RequestBitVector {
  has_feature_statement: PresenceBitValue;
  has_interface_contract: PresenceBitValue;
  has_bdd_ac: PresenceBitValue;
  /** Computed from the request's repo list (distinct URLs); never stored, never unknown. */
  repo_count: { value: number; bit_source: 'form' };
  /** True when any presence bit is unknown ⇒ PSD §7 `request_bit_unknown` / a question. */
  has_unknown: boolean;
}

/**
 * The full 4-bit vector for a request: stored bits (absent / NULL / malformed ⇒ unknown — a
 * malformed stored row never reads as a "no") + repo_count computed from `repoUrls`.
 */
export function requestBitVector(stored: unknown, repoUrls: readonly string[]): RequestBitVector {
  const parsed = StoredRequestBitsSchema.safeParse(stored ?? {});
  const bits: StoredRequestBits = parsed.success ? parsed.data : {};
  const pick = (n: PresenceBit): PresenceBitValue => bits[n] ?? UNKNOWN_BIT;
  const v = {
    has_feature_statement: pick('has_feature_statement'),
    has_interface_contract: pick('has_interface_contract'),
    has_bdd_ac: pick('has_bdd_ac'),
  };
  return {
    ...v,
    repo_count: { value: new Set(repoUrls.map((u) => u.trim()).filter(Boolean)).size, bit_source: 'form' },
    has_unknown: Object.values(v).some((b) => b.bit_source === 'unknown'),
  };
}

/** Merge a validated patch over the stored bits (per bit; an omitted bit keeps its value). */
export function mergeRequestBits(stored: unknown, patch: StoredRequestBits): StoredRequestBits {
  const parsed = StoredRequestBitsSchema.safeParse(stored ?? {});
  return { ...(parsed.success ? parsed.data : {}), ...patch };
}
