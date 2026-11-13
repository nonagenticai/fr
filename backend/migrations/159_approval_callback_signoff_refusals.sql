-- 159 — fr MERGE-QUEUE row 12. Two new terminal `callback_resolution` values for
-- workers/deblock-callback-redelivery.ts, written ONLY for an APPROVED row on the
-- `execution-ready-signoff-callback` receiver, and ONLY instead of a re-send:
--
--   'card_left_blocked_since_approval' — the card's Planka phase journey shows it
--       LEFT BLOCKED at or after the approval's created_at. It is in BLOCKED now for
--       a DIFFERENT reason (e.g. a QA verdict re-blocked it), so re-sending this
--       approval would free a card the approval never spoke about. The signoff
--       receiver moves a card to DOING from ANY list on a late approval.
--   'card_tenant_not_platform' — the card's owning tenant (board → project/stream,
--       the same chain GET /api/cards/:id gates on) is not in fr's
--       PLATFORM_TENANT_IDS. Strict tenant separation: the system operator never
--       acts on a customer card.
--
-- Neither claims a delivery; neither stamps callback_delivered_at. Nothing was sent.
--
-- ── WHY 159 ─────────────────────────────────────────────────────────────────
-- 158 is reserved (MERGE-QUEUE fr row 10 / CLAIMS). An absent number is reserved
-- until its PR merges without it.
--
-- ── SHAPE: DDL ONLY, NO DML ─────────────────────────────────────────────────
-- Same shape as 134: widens a CONSTRAINT DEFINITION and touches not one row.
-- ⛔ schema.ts AND THIS FILE MUST LIST THE SAME VALUES — a push-built CI database
-- takes the constraint from the `check()` in src/db/schema.ts, a migrated database
-- takes it from here.
--
-- Idempotent: the DO block re-reads pg_get_constraintdef and drops ONLY a
-- definition that does not already admit BOTH new values (definition, not name —
-- see 119/134). No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'approvals_callback_resolution_check'
     AND c.conrelid = 'approvals'::regclass;

  IF existing_def IS NOT NULL
     AND (existing_def NOT LIKE '%card_left_blocked_since_approval%'
          OR existing_def NOT LIKE '%card_tenant_not_platform%') THEN
    ALTER TABLE approvals DROP CONSTRAINT approvals_callback_resolution_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_callback_resolution_check
      CHECK (callback_resolution IS NULL
             OR callback_resolution IN ('moved', 'not_blocked', 'card_unreadable',
                                        'send_exhausted', 'hold_acknowledged',
                                        'read_degraded',
                                        'card_left_blocked_since_approval',
                                        'card_tenant_not_platform'));
  END IF;
END
$$;

COMMENT ON COLUMN approvals.callback_resolution IS
  'Terminal classification written ONLY by workers/deblock-callback-redelivery.ts. '
  'moved = we sent and the card was then observed out of BLOCKED (the only value that '
  'also stamps callback_delivered_at). not_blocked = the card was already off the board '
  'and we never sent. card_unreadable = Planka 404d the card ON ITS OWN READ PATH '
  'repeatedly over hours. send_exhausted = MAX_SEND_ATTEMPTS acked sends and the card '
  'never moved. hold_acknowledged = the receiver 200d and its own body reported it is '
  'holding the card ON PURPOSE, so fr stopped after one send. read_degraded = fr could '
  'never establish which list the card is in; nothing was sent. '
  'card_left_blocked_since_approval = (approved signoff rows only) the card left BLOCKED '
  'after the approval was created, so its current BLOCKED is not this approval''s; never '
  'sent. card_tenant_not_platform = (approved signoff rows only) the card''s owning '
  'tenant is not a platform tenant; never sent.';
