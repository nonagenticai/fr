// tests/unit/routes/execution-approvals-schema.test.ts
//
// Unit-tests the Zod schema for POST /api/execution/approvals (the AA
// ready-prefetch policy gate). Pins:
//   - callback_path: omitted / null / the canonical literal only;
//   - metadata.doingListId + metadata.boardId required (resume coords);
//   - project_id OR boardId required (the refine);
//   - project_id is a BOUNDED STRING, not a uuid — the shape test lives in the
//     handler (#910), where the sign-off block ledger is reachable;
//   - passthrough keeps extra n8n metadata.

import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_CALLBACK_PATH,
  SIGNOFF_ROLE,
  createExecutionApprovalSchema,
} from '../../../src/routes/execution-approvals';

const baseBody = {
  card_id: 'card-1',
  project_id: '00000000-0000-4000-8000-00000000aaaa',
  metadata: {
    doingListId: 'list-doing',
    boardId: 'board-1',
  },
};

describe('createExecutionApprovalSchema.callback_path', () => {
  test('omitted is valid (fr derives the canonical path)', () => {
    expect(createExecutionApprovalSchema.safeParse(baseBody).success).toBe(true);
  });

  test('explicit null is valid', () => {
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, callback_path: null }).success,
    ).toBe(true);
  });

  test('canonical literal is valid', () => {
    expect(
      createExecutionApprovalSchema.safeParse({
        ...baseBody,
        callback_path: CANONICAL_CALLBACK_PATH,
      }).success,
    ).toBe(true);
  });

  test('any other path is rejected', () => {
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, callback_path: 'something-else' })
        .success,
    ).toBe(false);
  });
});

describe('createExecutionApprovalSchema.metadata', () => {
  test('doingListId is required', () => {
    const parsed = createExecutionApprovalSchema.safeParse({
      ...baseBody,
      metadata: { boardId: 'board-1' },
    });
    expect(parsed.success).toBe(false);
  });

  test('boardId is required', () => {
    const parsed = createExecutionApprovalSchema.safeParse({
      ...baseBody,
      metadata: { doingListId: 'list-doing' },
    });
    expect(parsed.success).toBe(false);
  });

  test('todoListId + card_type are optional', () => {
    const parsed = createExecutionApprovalSchema.safeParse({
      ...baseBody,
      metadata: {
        doingListId: 'list-doing',
        boardId: 'board-1',
        todoListId: 'list-todo',
        card_type: 'project_execution',
      },
    });
    expect(parsed.success).toBe(true);
  });

  test('passthrough keeps extra metadata keys', () => {
    const parsed = createExecutionApprovalSchema.safeParse({
      ...baseBody,
      metadata: { doingListId: 'list-doing', boardId: 'board-1', card_name: 'Build X' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.metadata as Record<string, unknown>).card_name).toBe('Build X');
    }
  });
});

describe('createExecutionApprovalSchema project/board key', () => {
  test('boardId alone (no project_id) is valid', () => {
    const { project_id, ...noProject } = baseBody;
    void project_id;
    const parsed = createExecutionApprovalSchema.safeParse({
      ...noProject,
      boardId: 'board-1',
    });
    expect(parsed.success).toBe(true);
  });

  test('neither project_id nor boardId is rejected', () => {
    const { project_id, ...noProject } = baseBody;
    void project_id;
    expect(createExecutionApprovalSchema.safeParse(noProject).success).toBe(false);
  });

  // ⛔ CONTRACT CHANGE (#910), NOT AN OVERSIGHT. This used to assert
  // `.success === false` for a non-uuid project_id, because the field was
  // `z.string().uuid()`. `schema.parse()` runs BEFORE the handler, so that
  // rejection landed one step before `recordSignoffBlock` was reachable: the
  // n8n caller had already parked the card in BLOCKED, it discards the
  // response, and the ledger — whose whole purpose is to say why a card is
  // held — got no row at all. A malformed stamp was therefore treated strictly
  // WORSE than a merely wrong one, which #909 routes to the stream fallback and
  // records as `metadata.unresolved_project_id`.
  //
  // The shape test MOVED into the handler (`malformedProjectId`, via the
  // ANCHORED `isValidUuid`), where the ledger is reachable. What the schema
  // must still guarantee is only that the value is a BOUNDED STRING — the
  // handler and the database do the rest, and the two tests below pin that.
  test('non-uuid project_id is ACCEPTED by the schema and refused by the handler', () => {
    for (const junk of [
      '1770309213185115866', // the Planka snowflake — 5 of the 10 measured stamps
      '__system_workflow__',
      'auto',
      'smoke-plan-7',
      // a well-formed uuid DOUBLED across an embedded newline (2 measured cards).
      '00000000-0000-4000-8000-00000000aaaa\n00000000-0000-4000-8000-00000000aaaa',
    ]) {
      expect(
        createExecutionApprovalSchema.safeParse({ ...baseBody, project_id: junk }).success,
      ).toBe(true);
    }
  });

  test('project_id must still be a non-empty, bounded STRING', () => {
    // A number is the shape an untyped n8n expression most easily produces, and
    // it would reach `requested_project_id` (text) as something no operator can
    // grep for. Not widened.
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, project_id: 1770309213185115866 })
        .success,
    ).toBe(false);
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, project_id: '' }).success,
    ).toBe(false);
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, project_id: 'x'.repeat(257) })
        .success,
    ).toBe(false);
  });
});

describe('the proposition fields — a gate that cannot be answered is not a gate', () => {
  // ⛔ THE DEFECT. Measured on prod 2026-09-01: action_name / change_summary / impact_analysis
  // were NULL on 262 of 262 `execution.ready_signoff` rows, and across 908 approvals of every
  // kind NOT ONE has ever been rejected. The cause was not a missing column — all three exist
  // and are nullable — it was that `z.object()` STRIPS unknown keys SILENTLY, so n8n could send
  // a proposition, receive a 201, and have it discarded. A no-op that reports success.
  test('all three proposition fields SURVIVE parsing', () => {
    const parsed = createExecutionApprovalSchema.safeParse({
      ...baseBody,
      action_name: 'proceed_without_decision_asset',
      change_summary: 'The authoring worker reported: no in-scope requirements are attached.',
      impact_analysis: 'decision_authoring_gap',
    });
    expect(parsed.success).toBe(true);
    // ⭐ THE ASSERTION THAT MATTERS. `success === true` alone passes against the OLD schema too,
    // because stripping an unknown key is not a parse error. Only reading the values back
    // distinguishes "accepted" from "silently discarded" — that gap is the entire defect.
    if (parsed.success) {
      expect(parsed.data.action_name).toBe('proceed_without_decision_asset');
      expect(parsed.data.change_summary).toBe(
        'The authoring worker reported: no in-scope requirements are attached.',
      );
      expect(parsed.data.impact_analysis).toBe('decision_authoring_gap');
    }
  });

  test('they are OPTIONAL — an emitter that sends none still parses', () => {
    const parsed = createExecutionApprovalSchema.safeParse(baseBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.change_summary).toBeUndefined();
    }
  });

  test('an over-long change_summary is rejected rather than silently truncated', () => {
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, change_summary: 'x'.repeat(4001) })
        .success,
    ).toBe(false);
  });

  test('an over-long action_name is rejected', () => {
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, action_name: 'x'.repeat(201) })
        .success,
    ).toBe(false);
  });

  test('a non-string proposition field is rejected, not coerced', () => {
    expect(
      createExecutionApprovalSchema.safeParse({ ...baseBody, change_summary: 42 }).success,
    ).toBe(false);
  });
});

describe('constants', () => {
  test('CANONICAL_CALLBACK_PATH is the bare receiver path', () => {
    expect(CANONICAL_CALLBACK_PATH).toBe('execution-ready-signoff-callback');
  });

  test('SIGNOFF_ROLE is execution_signoff', () => {
    expect(SIGNOFF_ROLE).toBe('execution_signoff');
  });
});
