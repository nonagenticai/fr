// The hashes R10 recomputes — pinned by SHARED vectors.
//
// tests/unit/services/approvals/g12-row.vectors.json is the CONTRACT both implementations are
// tested against (docs/contracts/u3-a3-ncn-contracts.md §1–§3): fr's writeSetSeal /
// a3InputsHash / A6 mint here (the `row` vectors are R10's alone: fr derives no G-12 row), and R10's independent recomputation on its side. fr does not
// stamp the row on the approval (arbiter ruling 2026-10-02), so this file is the only place the
// two can be held to one rule.
//
// What this pins:
//   * write_set_seal / a3_inputs_hash / question_text_sha256: every vector via fr's REAL code
//     path (writeSetSeal, a3InputsHash, resolveU3Mint).
//   * NOT SELF-CERTIFYING: the expected values were produced once by those same functions, so
//     each one is ALSO recomputed here from node:crypto over a hand-written canonical form,
//     and canonicalizeJcs is asserted to produce exactly that form.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { canonicalizeJcs } from '../../../../src/lib/bug-report-hash';
import { writeSetSeal } from '../../../../src/lib/write-set';
import { assertWriteSetPaths } from '../../../../src/services/approvals/write-set-paths';
import { QUESTION_KIND, a3InputsHash, resolveU3Mint } from '../../../../src/services/approvals/u3-gates';
import VECTORS from './g12-row.vectors.json';

type RowVector = { name: string; kind: string; metadata: unknown; row: string | null };
type SealVector = { name: string; write_set: string[]; write_set_seal: string };
type A3Vector = { design_hash: string; write_set_seal: string; a3_inputs_hash: string };
type QuestionVector = { question_text: string; question_text_sha256: string };

const ROWS = VECTORS.row as RowVector[];
const SEALS = VECTORS.seal as SealVector[];
const A3S = VECTORS.a3_inputs_hash as A3Vector[];
const QUESTIONS = VECTORS.question_text_sha256 as QuestionVector[];

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** Hand-written RFC 8785 form of {v:1, write_set}: keys "v" < "write_set"; strings as JSON. */
const sealForm = (ws: string[]) => `{"v":1,"write_set":[${ws.map((p) => JSON.stringify(p)).join(',')}]}`;
/** Hand-written RFC 8785 form of A3's fold: "design_hash" < "v" < "write_set_seal". */
const a3Form = (d: string, s: string) => `{"design_hash":${JSON.stringify(d)},"v":1,"write_set_seal":${JSON.stringify(s)}}`;

describe('vectors file shape', () => {
  test('every row (and the null row) is covered, with seal / hash vectors', () => {
    expect([...new Set(ROWS.map((r) => r.row))].sort()).toEqual(['A1', 'A3', 'A4', 'A5', 'A6', null].sort());
    // Non-vacuity only: the vector lists below are iterated, so they must not be
    // empty. No fixture counts are pinned.
    expect(ROWS.filter((r) => r.row === null).length).toBeGreaterThan(0);
    expect(SEALS.length).toBeGreaterThan(0);
    expect(A3S.length).toBeGreaterThan(0);
    expect(QUESTIONS.length).toBeGreaterThan(0);
    for (const h of [...SEALS.map((v) => v.write_set_seal), ...A3S.map((v) => v.a3_inputs_hash), ...QUESTIONS.map((v) => v.question_text_sha256)]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the a3 vectors chain off seal vectors (one pipeline: write_set → seal → a3_inputs_hash)', () => {
    const seals = new Set(SEALS.map((v) => v.write_set_seal));
    for (const v of A3S) expect(seals.has(v.write_set_seal)).toBe(true);
  });
});

describe('write_set_seal vectors', () => {
  for (const v of SEALS) {
    test(`${v.name}: a VALID set, and fr's writeSetSeal reproduces the vector`, () => {
      expect(() => assertWriteSetPaths(v.write_set)).not.toThrow();
      expect(writeSetSeal(v.write_set)).toBe(v.write_set_seal);
    });

    test(`${v.name}: INDEPENDENT — sha256 over the hand-written canonical form`, () => {
      expect(canonicalizeJcs({ v: 1, write_set: v.write_set })).toBe(sealForm(v.write_set));
      expect(sha256(sealForm(v.write_set))).toBe(v.write_set_seal);
    });
  }

  test('CONTROL: the non-ASCII vector is in UTF-8 byte order, which is NOT the JS (UTF-16) default order', () => {
    const v = SEALS.find((s) => s.write_set.some((p) => /[^\x00-\x7f]/.test(p)))!;
    expect(v).toBeDefined();
    expect([...v.write_set].sort()).not.toEqual(v.write_set);
    // and the order is load-bearing: the UTF-16 order seals differently
    expect(sha256(sealForm([...v.write_set].sort()))).not.toBe(v.write_set_seal);
  });
});

describe('a3_inputs_hash vectors', () => {
  for (const v of A3S) {
    test(`design ${v.design_hash.slice(0, 8)}… + seal ${v.write_set_seal.slice(0, 8)}…: fr reproduces it`, () => {
      expect(a3InputsHash(v.design_hash, v.write_set_seal)).toBe(v.a3_inputs_hash);
    });

    test(`design ${v.design_hash.slice(0, 8)}…: INDEPENDENT — sha256 over the hand-written canonical form`, () => {
      expect(canonicalizeJcs({ v: 1, design_hash: v.design_hash, write_set_seal: v.write_set_seal })).toBe(
        a3Form(v.design_hash, v.write_set_seal),
      );
      expect(sha256(a3Form(v.design_hash, v.write_set_seal))).toBe(v.a3_inputs_hash);
    });
  }

  test('CONTROL: the bare design_hash and the bare seal are NOT the a3_inputs_hash', () => {
    for (const v of A3S) {
      expect(v.a3_inputs_hash).not.toBe(v.design_hash);
      expect(v.a3_inputs_hash).not.toBe(v.write_set_seal);
    }
  });
});

describe('question_text_sha256 vectors', () => {
  for (const v of QUESTIONS) {
    test(`${JSON.stringify(v.question_text).slice(0, 40)}: the A6 mint stamps the vector; node:crypto agrees`, async () => {
      const res = await resolveU3Mint({
        rawBody: {
          kind: QUESTION_KIND,
          deblock_action: 'QUESTION',
          open_questions: [v.question_text],
          metadata: { question_id: 'Q1', question_text: v.question_text },
        },
        cardId: 'c',
        tenantId: '00000000-0000-0000-0000-000000000000',
      });
      expect(res!.metadata.question_text_sha256).toBe(v.question_text_sha256);
      expect(sha256(v.question_text)).toBe(v.question_text_sha256);
    });
  }

  test('CONTROL: the text is hashed as given — NFC and NFD forms of the same glyph differ', () => {
    const nfd = QUESTIONS.find((q) => q.question_text === 'é')!;
    expect(nfd).toBeDefined();
    expect(sha256(nfd.question_text.normalize('NFC'))).not.toBe(nfd.question_text_sha256);
  });
});
