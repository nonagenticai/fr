// U3/A3 — the WRITE SET on a feature-design approval (src/services/approvals/u3-gates.ts).
//
// Contract: docs/contracts/u3-a3-ncn-contracts.md §1 (FROZEN WRITE_SET CONTRACT, U4-diff-scope-recon.md).
// DB-free: the design mint and decide gates never read the database.
//
// What this pins:
//   * MINT: metadata.write_set is REQUIRED — missing / not an array / a non-string entry /
//     empty / a bad path form / a duplicate / not UTF-8 byte-sorted ⇒ 422 write_set_invalid;
//     more than 40 paths ⇒ 422 write_set_too_broad. Nothing is ever re-sorted.
//   * MINT stores write_set EXACTLY as sent (literal '[', ' ', '+', '(' …), plus
//     write_set_seal = writeSetSeal(write_set) and
//     a3_inputs_hash = sha256_hex(JCS({v:1, design_hash, write_set_seal})).
//   * DECIDE: inputs_hash must equal metadata.a3_inputs_hash (the bare design_hash is wrong);
//     a stored row with no write_set / seal / a3 hash ⇒ 409 write_set_missing; a write_set,
//     seal or a3 hash that no longer recompute ⇒ 409 write_set_seal_mismatch.
//   * DEDUPE: the seal is part of A3's identity (a different set ⇒ 409 open_gate_conflict).
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

import { writeSetSeal } from '../../../../src/lib/write-set';
import { WRITE_SET_MAX } from '../../../../src/services/approvals/write-set-paths';
import {
  FEATURE_DESIGN_APPROVAL_KIND,
  a3InputsHash,
  assertU3DecideGates,
  assertU3DedupeCompatible,
  resolveU3Mint,
} from '../../../../src/services/approvals/u3-gates';
import { AppError } from '../../../../src/utils/errors';
import { A3_INPUTS_HASH, WRITE_SET, designMetadata, g12, sealedDesignMetadata, HUMAN_DECIDER_ID } from './u3-fixtures';

const TENANT = randomUUID();

/** Run `fn`, return the AppError it throws (status + code), or fail. */
async function refusal(fn: () => unknown): Promise<{ status: number; code?: string }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return { status: (err as AppError).statusCode, code: (err as AppError).code };
  }
  throw new Error('expected a refusal, got none');
}

const mint = (metadata: Record<string, unknown>) =>
  resolveU3Mint({ rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata }, cardId: 'c', tenantId: TENANT });

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('A3 mint: write_set is required and validated (422, nothing minted)', () => {
  test('missing / not an array / a non-string entry ⇒ write_set_invalid', async () => {
    const md = designMetadata();
    delete md.write_set;
    expect(await refusal(() => mint(md))).toEqual({ status: 422, code: 'write_set_invalid' });
    for (const write_set of [null, 'src/a.ts', { 0: 'src/a.ts' }, 1, ['src/a.ts', 2], [null]]) {
      expect([write_set, await refusal(() => mint(designMetadata({ write_set })))]).toEqual([
        write_set,
        { status: 422, code: 'write_set_invalid' },
      ]);
    }
  });

  test('empty, a duplicate, and an unsorted set ⇒ write_set_invalid (never re-sorted)', async () => {
    for (const write_set of [[], ['src/a.ts', 'src/a.ts'], ['src/b.ts', 'src/a.ts']]) {
      expect([write_set, await refusal(() => mint(designMetadata({ write_set })))]).toEqual([
        write_set,
        { status: 422, code: 'write_set_invalid' },
      ]);
    }
  });

  test('sorted by UTF-8 BYTES, not UTF-16 code units: the JS-default order is refused', async () => {
    // U+FF5E is EF BD 9E in UTF-8 and sorts BEFORE U+1F600 (F0 9F 98 80); in UTF-16 the
    // emoji's high surrogate (0xD83D) sorts first. Byte order is the contract's.
    const bytes = ['a/～.ts', 'a/\u{1F600}.ts'];
    expect([...bytes].sort()).toEqual([...bytes].reverse()); // CONTROL: the two orders differ
    const ok = await mint(designMetadata({ write_set: bytes }));
    expect(ok!.metadata.write_set).toEqual(bytes);
    expect(await refusal(() => mint(designMetadata({ write_set: [...bytes].sort() })))).toEqual({
      status: 422,
      code: 'write_set_invalid',
    });
  });

  test('every refused path form ⇒ write_set_invalid', async () => {
    for (const bad of ['', 'src/*.ts', 'src/?.ts', 'src/../x.ts', '..', '/src/a.ts', 'src/', 'src//a.ts', 'src/a\u0000.ts', 'src/a\n.ts', 'src\\a.ts']) {
      expect([bad, await refusal(() => mint(designMetadata({ write_set: [bad] })))]).toEqual([
        bad,
        { status: 422, code: 'write_set_invalid' },
      ]);
    }
  });

  test(`more than ${WRITE_SET_MAX} paths ⇒ write_set_too_broad; exactly ${WRITE_SET_MAX} mints`, async () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
    expect(await refusal(() => mint(designMetadata({ write_set: paths(WRITE_SET_MAX + 1) })))).toEqual({
      status: 422,
      code: 'write_set_too_broad',
    });
    const ok = await mint(designMetadata({ write_set: paths(WRITE_SET_MAX) }));
    expect(ok!.metadata.write_set).toHaveLength(WRITE_SET_MAX);
  });
});

describe('A3 mint: stored exactly as sent, sealed, and the seal folded into a3_inputs_hash', () => {
  test('literal [ ] { } ( ) + ~ @ # % and space are accepted and stored verbatim', async () => {
    const write_set = ['src/[id].ts', 'src/a b+c(1)~@#%.ts', 'src/{x}.ts'];
    const res = await mint(designMetadata({ write_set }));
    expect(res!.metadata.write_set).toEqual(write_set);
    expect(res!.metadata.write_set_seal).toBe(writeSetSeal(write_set));
  });

  test('the stored seal and a3_inputs_hash are the contract formulas (recomputed here independently)', async () => {
    const res = await mint(designMetadata());
    const seal = sha256(JSON.stringify({ v: 1, write_set: WRITE_SET }));
    expect(res!.metadata.write_set_seal).toBe(seal);
    // hand-written JCS: keys in code-unit order "design_hash" < "v" < "write_set_seal".
    const a3 = sha256(`{"design_hash":"${'d'.repeat(64)}","v":1,"write_set_seal":"${seal}"}`);
    expect(res!.metadata.a3_inputs_hash).toBe(a3);
    expect(a3InputsHash('d'.repeat(64), seal)).toBe(a3);
    expect(res!.metadata.a3_inputs_hash).toBe(A3_INPUTS_HASH);
  });

  test('a different write set ⇒ a different seal ⇒ a different a3_inputs_hash (same design)', async () => {
    const a = await mint(designMetadata());
    const b = await mint(designMetadata({ write_set: ['src/design.ts'] }));
    expect(b!.metadata.write_set_seal).not.toBe(a!.metadata.write_set_seal);
    expect(b!.metadata.a3_inputs_hash).not.toBe(a!.metadata.a3_inputs_hash);
  });

  test('a sender-supplied seal / a3 hash is ignored: fr computes both', async () => {
    const res = await mint(designMetadata({ write_set_seal: 'e'.repeat(64), a3_inputs_hash: 'e'.repeat(64) }));
    expect(res!.metadata.write_set_seal).toBe(writeSetSeal(WRITE_SET));
    expect(res!.metadata.a3_inputs_hash).toBe(A3_INPUTS_HASH);
  });
});

describe('A3 decide: bound to a3_inputs_hash and a write set that still recomputes', () => {
  const approval = (metadata: Record<string, unknown>) => ({
    id: randomUUID(),
    tenant_id: TENANT,
    kind: FEATURE_DESIGN_APPROVAL_KIND,
    metadata,
  });
  const decide = (metadata: Record<string, unknown>, inputs_hash = A3_INPUTS_HASH) =>
    assertU3DecideGates({
      approval: approval(metadata),
      rawBody: {
        g12_decision: g12({
          rule_row: 'A3',
          inputs_hash,
          items: [{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }],
        }),
      },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });

  test('happy path: a minted row decided with its a3_inputs_hash', async () => {
    const minted = await mint(designMetadata());
    const out = await decide(minted!.metadata as Record<string, unknown>, minted!.metadata.a3_inputs_hash as string);
    expect(out?.inputs_hash).toBe(A3_INPUTS_HASH);
    expect(out?.items).toEqual([{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }]);
  });

  test('any decider-supplied deblock_action ⇒ 422 deblock_action_not_allowed (defence in depth)', async () => {
    const md = sealedDesignMetadata();
    for (const action of ['DROP', 'RETRY', 'QUESTION']) {
      expect(
        await refusal(() =>
          assertU3DecideGates({
            approval: approval(md),
            rawBody: {
              deblock_action: action,
              g12_decision: g12({
                rule_row: 'A3',
                inputs_hash: A3_INPUTS_HASH,
                items: [{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }],
              }),
            },
            status: 'approved',
            deciderId: HUMAN_DECIDER_ID,
          }),
        ),
      ).toEqual({ status: 422, code: 'deblock_action_not_allowed' });
    }
  });

  test('the bare design_hash, or the seal alone, is 409 inputs_hash_mismatch', async () => {
    const md = sealedDesignMetadata();
    for (const wrong of ['d'.repeat(64), md.write_set_seal as string]) {
      expect(await refusal(() => decide(md, wrong))).toEqual({ status: 409, code: 'inputs_hash_mismatch' });
    }
  });

  test('a stored row with no write_set / write_set_seal / a3_inputs_hash ⇒ 409 write_set_missing', async () => {
    for (const missing of ['write_set', 'write_set_seal', 'a3_inputs_hash']) {
      const md = sealedDesignMetadata();
      delete md[missing];
      expect([missing, await refusal(() => decide(md))]).toEqual([missing, { status: 409, code: 'write_set_missing' }]);
    }
    // a pre-seal row (minted before the write set existed) cannot be decided at all
    const legacy = designMetadata();
    delete legacy.write_set;
    expect(await refusal(() => decide(legacy, 'd'.repeat(64)))).toEqual({ status: 409, code: 'write_set_missing' });
  });

  test('tampered after mint ⇒ 409 write_set_seal_mismatch (write_set, seal, a3 hash, invalid stored set)', async () => {
    const md = sealedDesignMetadata();
    const tampered: Array<[string, Record<string, unknown>]> = [
      ['write_set widened', { ...md, write_set: ['src/design.ts', 'src/other.ts', 'tests/design.test.ts'] }],
      ['write_set re-ordered', { ...md, write_set: [...WRITE_SET].reverse() }],
      ['seal replaced', { ...md, write_set_seal: 'e'.repeat(64) }],
      ['a3 hash replaced', { ...md, a3_inputs_hash: 'e'.repeat(64) }],
      ['design_hash replaced (no re-fold)', { ...md, design_hash: 'e'.repeat(64) }],
      ['stored set empty', { ...md, write_set: [] }],
    ];
    for (const [name, metadata] of tampered) {
      // the stored a3 hash is what the decider would carry: still refused, because the row no longer recomputes
      expect([name, await refusal(() => decide(metadata, metadata.a3_inputs_hash as string))]).toEqual([
        name,
        { status: 409, code: 'write_set_seal_mismatch' },
      ]);
    }
  });
});

describe('A3 dedupe identity includes write_set_seal', () => {
  test('re-sending the same design + write set dedupes; a different set is 409 open_gate_conflict', async () => {
    const a = await mint(designMetadata());
    const b = await mint(designMetadata({ write_set: ['src/design.ts'] }));
    expect(() => assertU3DedupeCompatible(a, { id: 'open', kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: a!.metadata })).not.toThrow();
    expect(
      await refusal(() => assertU3DedupeCompatible(b, { id: 'open', kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: a!.metadata })),
    ).toEqual({ status: 409, code: 'open_gate_conflict' });
  });
});
