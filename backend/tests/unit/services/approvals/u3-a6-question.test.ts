// U3 — G-12 A6: the conveyor QUESTION (`execution.question`) mint + decide gates
// (src/services/approvals/u3-gates.ts; registry: question-registry.ts).
//
// Contract: docs/contracts/u3-a3-ncn-contracts.md §2 (arbiter ruling, movies-ab 2026-10-02).
// DB-free: neither the A6 mint nor its decide reads the database.
//
// What this pins:
//   * MINT: deblock_action QUESTION, open_questions === [question_text], question_text
//     1..4000 chars; question_id Q1..Q8 stamped as sent, absent/null stored as null;
//     any other question_id ⇒ 422 question_id_invalid; every other defect ⇒ 422
//     question_metadata_invalid. fr stamps question_text_sha256 (sha256 hex of the UTF-8
//     text) and g12_rule_version (= G12_RULE_VERSION_V2). It never maps text to an id.
//   * DECIDE: inputs_hash = question_text_sha256 (else 409 inputs_hash_mismatch); exactly
//     one item whose item_id is the stamped id, or `no_registered_answer` when none was
//     stamped (else 422 items_mismatch); approve only for Q1–Q7 with `answered:<stamped>`
//     (Q8 / unstamped ⇒ 422 question_not_answerable; a code for ANOTHER answerable id ⇒
//     422 reason_code_not_stamped; `answered:Q8` is no code at all ⇒ reason_code_not_in_rule);
//     reject only with `no_registered_answer`; status must match the item.
//   * a6RegisteredAnswerFor: the REGISTERED answer for an approved Q1–Q7, null otherwise.
//   * question_rule_version (optional, 1..128 chars, no control chars) stored verbatim; key
//     absent when not sent; any other value ⇒ 422 question_metadata_invalid.
//   * dedupe identity: (question_id, question_text_sha256).
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

import { G12_RULE_VERSION_V1, G12_RULE_VERSION_V2 } from '../../../../src/services/approvals/g12-rule';
import { QUESTION_REGISTRY } from '../../../../src/services/approvals/question-registry';
import {
  QUESTION_KIND,
  U3_DECIDE_GATED_KINDS,
  U3_SENDABLE_KINDS,
  a6RegisteredAnswerFor,
  assertU3DecideGates,
  assertU3DedupeCompatible,
  resolveU3Mint,
} from '../../../../src/services/approvals/u3-gates';
import { AppError } from '../../../../src/utils/errors';
import { g12, HUMAN_DECIDER_ID } from './u3-fixtures';

const TENANT = randomUUID();
const TEXT = 'Should I also bump the lockfile?';
const ANSWERABLE = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] as const;

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

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** The request ncn sends (contract §2). `metadata` keys are spread, so `undefined` = absent. */
function questionBody(metadata: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  const text = 'question_text' in metadata ? metadata.question_text : TEXT;
  return {
    kind: QUESTION_KIND,
    deblock_action: 'QUESTION',
    open_questions: [text],
    metadata: { question_id: 'Q2', question_text: TEXT, ...metadata },
    ...top,
  };
}

const mint = (body: Record<string, unknown>) => resolveU3Mint({ rawBody: body, cardId: 'c', tenantId: TENANT });

describe('A6 mint', () => {
  test('execution.question is sendable and decide-gated', () => {
    expect(U3_SENDABLE_KINDS).toContain(QUESTION_KIND);
    expect(U3_DECIDE_GATED_KINDS).toContain(QUESTION_KIND);
  });

  test('Q1..Q8 are stamped as sent, with the text sha256 and the v2 rule version', async () => {
    for (const id of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']) {
      const res = await mint(questionBody({ question_id: id }));
      expect(res?.kind).toBe(QUESTION_KIND);
      expect(res!.metadata).toEqual({
        question_id: id,
        question_text: TEXT,
        question_text_sha256: sha256(TEXT),
        g12_rule_version: G12_RULE_VERSION_V2,
      });
    }
  });

  test('question_id absent or null ⇒ minted, stored as null (not covered by §3)', async () => {
    for (const question_id of [undefined, null]) {
      const res = await mint(questionBody({ question_id }));
      expect([question_id, res!.metadata.question_id]).toEqual([question_id, null]);
    }
  });

  test('the sha256 is over the exact UTF-8 bytes (unicode + emoji), never a normalised form', async () => {
    const text = 'Ünïcödé — which branch? 🚀\nline 2';
    const res = await mint(questionBody({ question_text: text }));
    expect(res!.metadata.question_text).toBe(text);
    expect(res!.metadata.question_text_sha256).toBe(sha256(text));
    // CONTROL: NFC vs NFD differ in bytes, so they differ in hash
    const nfd = 'é'.normalize('NFD');
    const a = await mint(questionBody({ question_text: 'é'.normalize('NFC') }));
    const b = await mint(questionBody({ question_text: nfd }));
    expect(a!.metadata.question_text_sha256).not.toBe(b!.metadata.question_text_sha256);
  });

  test('any other question_id ⇒ 422 question_id_invalid', async () => {
    for (const question_id of ['q1', 'Q9', 'Q0', ' Q1', 'Q1 ', '', 1, true, ['Q1'], { id: 'Q1' }]) {
      expect([question_id, await refusal(() => mint(questionBody({ question_id })))]).toEqual([
        question_id,
        { status: 422, code: 'question_id_invalid' },
      ]);
    }
  });

  test('question_text missing / empty / blank / not a string / over 4000 ⇒ 422 question_metadata_invalid', async () => {
    for (const question_text of [undefined, '', '   ', 42, null, 'x'.repeat(4001)]) {
      expect([String(question_text).slice(0, 8), await refusal(() => mint(questionBody({ question_text })))]).toEqual([
        String(question_text).slice(0, 8),
        { status: 422, code: 'question_metadata_invalid' },
      ]);
    }
    // the boundary is inclusive
    const max = 'x'.repeat(4000);
    expect((await mint(questionBody({ question_text: max })))!.metadata.question_text).toBe(max);
  });

  test('deblock_action not QUESTION ⇒ 422 question_metadata_invalid', async () => {
    for (const deblock_action of [undefined, 'RETRY', 'question', 'INFRASTRUCTURE']) {
      expect([deblock_action, await refusal(() => mint(questionBody({}, { deblock_action })))]).toEqual([
        deblock_action,
        { status: 422, code: 'question_metadata_invalid' },
      ]);
    }
  });

  test('open_questions not exactly [question_text] ⇒ 422 question_metadata_invalid', async () => {
    for (const open_questions of [undefined, [], [TEXT, TEXT], ['another question'], [`${TEXT} `], TEXT]) {
      expect([open_questions, await refusal(() => mint(questionBody({}, { open_questions })))]).toEqual([
        open_questions,
        { status: 422, code: 'question_metadata_invalid' },
      ]);
    }
  });

  test('question_rule_version (the conveyor classifier version): stored verbatim when sent, key absent otherwise', async () => {
    for (const v of ['ncn-classifier@2026-10-02', 'x', 'v'.repeat(128), 'sha256:abc def/ü']) {
      const res = await mint(questionBody({ question_rule_version: v }));
      expect(res!.metadata.question_rule_version).toBe(v);
    }
    // absent — and null, which reads as absent — leave NO key (never `undefined` / null stored)
    for (const question_rule_version of [undefined, null]) {
      const res = await mint(questionBody({ question_rule_version }));
      expect([question_rule_version, 'question_rule_version' in res!.metadata]).toEqual([question_rule_version, false]);
    }
    // it is not part of the A6 identity or inputs_hash: the sha256 is still the text's
    const res = await mint(questionBody({ question_rule_version: 'r1' }));
    expect(res!.metadata.question_text_sha256).toBe(sha256(TEXT));
  });

  test('question_rule_version empty / blank / over 128 / non-string / control chars ⇒ 422 question_metadata_invalid', async () => {
    for (const question_rule_version of ['', '   ', 'v'.repeat(129), 7, true, ['r1'], { v: 1 }, 'r1\n', 'r\u00001', 'r\t1', 'r\u007f']) {
      expect([question_rule_version, await refusal(() => mint(questionBody({ question_rule_version })))]).toEqual([
        question_rule_version,
        { status: 422, code: 'question_metadata_invalid' },
      ]);
    }
  });

  test('dedupe identity is (question_id, question_text_sha256)', async () => {
    const a = await mint(questionBody());
    const open = { id: 'open', kind: QUESTION_KIND, metadata: a!.metadata };
    expect(() => assertU3DedupeCompatible(a, open)).not.toThrow();
    const otherId = await mint(questionBody({ question_id: 'Q3' }));
    const otherText = await mint(questionBody({ question_text: 'Which repo?' }));
    for (const u3 of [otherId, otherText]) {
      expect(await refusal(() => assertU3DedupeCompatible(u3, open))).toEqual({ status: 409, code: 'open_gate_conflict' });
    }
  });
});

describe('A6 decide', () => {
  /** A row as fr stored it at mint (the REAL mint output, not a hand-built metadata). */
  async function minted(question_id: string | null) {
    const res = await mint(questionBody({ question_id }));
    return { id: randomUUID(), tenant_id: TENANT, kind: QUESTION_KIND, metadata: res!.metadata as Record<string, unknown> };
  }
  const decide = (
    approval: Awaited<ReturnType<typeof minted>>,
    items: unknown[] | undefined,
    status: 'approved' | 'rejected',
    opts: { inputs_hash?: string; rule_row?: string; version?: string; extra?: Record<string, unknown> } = {},
  ) =>
    assertU3DecideGates({
      approval,
      rawBody: {
        g12_decision: {
          ...g12(
            { rule_row: opts.rule_row ?? 'A6', inputs_hash: opts.inputs_hash ?? sha256(TEXT), items: items as unknown[] },
            opts.version,
          ),
          ...opts.extra,
        },
      },
      status,
      deciderId: HUMAN_DECIDER_ID,
    });

  test('Q1–Q7: approve with answered:<stamped id> is accepted', async () => {
    for (const id of ANSWERABLE) {
      const out = await decide(await minted(id), [{ item_id: id, decision: 'approve', reason_code: `answered:${id}` }], 'approved');
      expect(out?.rule_row).toBe('A6');
      expect(out?.rule_version).toBe(G12_RULE_VERSION_V2);
      expect(out?.inputs_hash).toBe(sha256(TEXT));
      expect(out?.items).toEqual([{ item_id: id, decision: 'approve', reason_code: `answered:${id}` }]);
    }
  });

  test('reject no_registered_answer is accepted for every stamp (Q1–Q8) and for an unstamped row', async () => {
    for (const id of [...ANSWERABLE, 'Q8']) {
      const out = await decide(await minted(id), [{ item_id: id, decision: 'reject', reason_code: 'no_registered_answer' }], 'rejected');
      expect(out?.items[0]).toEqual({ item_id: id, decision: 'reject', reason_code: 'no_registered_answer' });
    }
    const none = await decide(
      await minted(null),
      [{ item_id: 'no_registered_answer', decision: 'reject', reason_code: 'no_registered_answer' }],
      'rejected',
    );
    expect(none?.items[0]?.item_id).toBe('no_registered_answer');
  });

  test('a decider-supplied deblock_action other than QUESTION ⇒ 422 deblock_action_not_allowed (defence in depth)', async () => {
    const approval = await minted('Q2');
    for (const action of ['DROP', 'RETRY', 'RECLASSIFY']) {
      expect(
        await refusal(() =>
          assertU3DecideGates({
            approval,
            rawBody: {
              deblock_action: action,
              g12_decision: g12({ rule_row: 'A6', inputs_hash: sha256(TEXT), items: [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }] }),
            },
            status: 'approved',
            deciderId: HUMAN_DECIDER_ID,
          }),
        ),
      ).toMatchObject({ code: 'deblock_action_not_allowed' });
    }
    // Echoing the stored QUESTION is not an override.
    const ok = await assertU3DecideGates({
      approval,
      rawBody: {
        deblock_action: 'QUESTION',
        g12_decision: g12({ rule_row: 'A6', inputs_hash: sha256(TEXT), items: [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }] }),
      },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(ok?.rule_row).toBe('A6');
  });

  test('A6 is identical in v1: a v1-stamped decision validates and stays v1', async () => {
    const out = await decide(await minted('Q2'), [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }], 'approved', {
      version: G12_RULE_VERSION_V1,
    });
    expect(out?.rule_version).toBe(G12_RULE_VERSION_V1);
  });

  test('inputs_hash not the question_text_sha256 ⇒ 409 inputs_hash_mismatch', async () => {
    const approval = await minted('Q2');
    for (const inputs_hash of ['e'.repeat(64), sha256(`${TEXT} `)]) {
      expect(
        await refusal(() => decide(approval, [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }], 'approved', { inputs_hash })),
      ).toEqual({ status: 409, code: 'inputs_hash_mismatch' });
    }
  });

  test('items not exactly the one stamped question ⇒ 422 items_mismatch', async () => {
    const q2 = await minted('Q2');
    const none = await minted(null);
    const cases: Array<[string, Awaited<ReturnType<typeof minted>>, unknown[] | undefined]> = [
      ['no items', q2, undefined],
      ['empty items', q2, []],
      ['another id', q2, [{ item_id: 'Q3', decision: 'reject', reason_code: 'no_registered_answer' }]],
      ['the literal on a stamped row', q2, [{ item_id: 'no_registered_answer', decision: 'reject', reason_code: 'no_registered_answer' }]],
      [
        'two items',
        q2,
        [
          { item_id: 'Q2', decision: 'reject', reason_code: 'no_registered_answer' },
          { item_id: 'Q3', decision: 'reject', reason_code: 'no_registered_answer' },
        ],
      ],
      ['a Q-id on an unstamped row', none, [{ item_id: 'Q2', decision: 'reject', reason_code: 'no_registered_answer' }]],
    ];
    for (const [name, approval, items] of cases) {
      expect([name, await refusal(() => decide(approval, items, 'rejected'))]).toEqual([
        name,
        { status: 422, code: 'items_mismatch' },
      ]);
    }
  });

  test('approving Q8 or an unstamped question ⇒ 422 question_not_answerable', async () => {
    expect(
      await refusal(async () => decide(await minted('Q8'), [{ item_id: 'Q8', decision: 'approve', reason_code: 'answered:Q1' }], 'approved')),
    ).toEqual({ status: 422, code: 'question_not_answerable' });
    expect(
      await refusal(async () =>
        decide(await minted(null), [{ item_id: 'no_registered_answer', decision: 'approve', reason_code: 'answered:Q1' }], 'approved'),
      ),
    ).toEqual({ status: 422, code: 'question_not_answerable' });
  });

  test('approve with ANOTHER answerable id\'s code ⇒ 422 reason_code_not_stamped', async () => {
    const approval = await minted('Q2');
    for (const other of ANSWERABLE.filter((id) => id !== 'Q2')) {
      expect([
        other,
        await refusal(() => decide(approval, [{ item_id: 'Q2', decision: 'approve', reason_code: `answered:${other}` }], 'approved')),
      ]).toEqual([other, { status: 422, code: 'reason_code_not_stamped' }]);
    }
  });

  test('codes outside the A6 row are refused: answered:Q8, no_registered_answer as approve, answered:Qn as reject', async () => {
    const q8 = await minted('Q8');
    const q2 = await minted('Q2');
    const cases: Array<[Awaited<ReturnType<typeof minted>>, Record<string, unknown>, 'approved' | 'rejected']> = [
      [q8, { item_id: 'Q8', decision: 'approve', reason_code: 'answered:Q8' }, 'approved'],
      [q2, { item_id: 'Q2', decision: 'approve', reason_code: 'no_registered_answer' }, 'approved'],
      [q2, { item_id: 'Q2', decision: 'reject', reason_code: 'answered:Q2' }, 'rejected'],
      [q2, { item_id: 'Q2', decision: 'approve', reason_code: 'design_ok' }, 'approved'],
    ];
    for (const [approval, item, status] of cases) {
      expect([item.reason_code, await refusal(() => decide(approval, [item], status))]).toEqual([
        item.reason_code,
        { status: 422, code: 'reason_code_not_in_rule' },
      ]);
    }
  });

  test('status must follow from the item ⇒ 422 decision_items_inconsistent', async () => {
    const approval = await minted('Q2');
    expect(
      await refusal(() => decide(approval, [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }], 'rejected')),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
    expect(
      await refusal(() => decide(approval, [{ item_id: 'Q2', decision: 'reject', reason_code: 'no_registered_answer' }], 'approved')),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
  });

  test('structural refusals: no g12_decision, the wrong row, an A1 reject_reason_code, an uncited row', async () => {
    const approval = await minted('Q2');
    const item = [{ item_id: 'Q2', decision: 'approve', reason_code: 'answered:Q2' }];
    expect(await refusal(() => assertU3DecideGates({ approval, rawBody: {}, status: 'approved', deciderId: HUMAN_DECIDER_ID }))).toEqual({
      status: 422,
      code: 'g12_decision_required',
    });
    expect(await refusal(() => decide(approval, item, 'approved', { rule_row: 'A3' }))).toEqual({
      status: 422,
      code: 'g12_rule_row_mismatch',
    });
    expect(
      await refusal(() => decide(approval, item, 'approved', { extra: { reject_reason_code: 'no_registered_answer' } })),
    ).toEqual({ status: 422, code: 'g12_decision_invalid' });
    const uncited = { ...approval, metadata: { ...approval.metadata, question_text_sha256: undefined } };
    expect(await refusal(() => decide(uncited, item, 'approved'))).toEqual({ status: 409, code: 'question_not_cited' });
  });
});

describe('a6RegisteredAnswerFor — the decision text an approved A6 records', () => {
  test('approved Q1–Q7 ⇒ the registered §3 answer', () => {
    for (const id of ANSWERABLE) {
      expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: id } }, 'approved')).toBe(
        QUESTION_REGISTRY[id].answer,
      );
    }
    // pinned spot checks against the contract table (not only the registry it came from)
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: 'Q6' } }, 'approved')).toBe('NO');
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: 'Q2' } }, 'approved')).toBe(
      'NO (§V: out of scope; P1.10)',
    );
  });

  test('a REJECTED A6 records exactly no_registered_answer, whatever was stamped', () => {
    for (const id of ['Q2', 'Q8', null]) {
      expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: id } }, 'rejected')).toBe('no_registered_answer');
    }
    expect(a6RegisteredAnswerFor({ kind: 'generic', metadata: { question_id: 'Q2' } }, 'rejected')).toBeNull();
  });

  test('null otherwise: Q8, unstamped, an invalid id, another kind, non-object metadata', () => {
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: 'Q8' } }, 'approved')).toBeNull();
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: null } }, 'approved')).toBeNull();
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: { question_id: 'Q9' } }, 'approved')).toBeNull();
    expect(a6RegisteredAnswerFor({ kind: 'generic', metadata: { question_id: 'Q2' } }, 'approved')).toBeNull();
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: null }, 'approved')).toBeNull();
    expect(a6RegisteredAnswerFor({ kind: QUESTION_KIND, metadata: 'Q2' }, 'approved')).toBeNull();
  });
});
