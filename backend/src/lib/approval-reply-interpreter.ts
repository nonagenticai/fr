// src/lib/approval-reply-interpreter.ts
//
// Free-text chat replies to an approval are read by laya, not by a regex grammar.
//
// ⭐ GEORGE, 2026-10-23 (after "approved" in Telegram reached the agent and was answered
// "I didn't recognize that as an action"): "send the user input to laya with the three
// choice options and let laya make the decision, and also ask laya if there is additional
// information in the user telegram message so that if that is true, you can sent that
// additional information into the system if needed".
//
// The exact grammar in routes/telegram-webhook.ts stays the fast path (`parseDecision`:
// `1`, `approve`, `2 <reason>`, `approve: <answer>` …). Only what it cannot read comes here.
//
// ── TRANSPORT + CREDENTIAL ────────────────────────────────────────────────────────────
// POST {LAYA_SYSTEMONE_URL, default https://api.nonagentic.ai/laya/v1/systemone}, the Jev
// request/response shape (laya's bridge on pgx behind licence-authz, app `laya`). The
// credential is the APPROVAL TENANT's own `laya` licence, minted per tenant by licenses'
// bundle-token route (`getBundleTokenMinter('laya')`, `laya` is a `conveyor` bundle
// member) — licences are tenant×app only (George 2026-10-15), so fr never sends a licence
// of its own or anybody else's. Measured from the fr pod 2026-10-23: the public route
// answers (401 without a bearer, 53–147 ms); the in-mesh ServiceEntry is exported to
// istio-system only, so the public route is the one an fr pod can use.
//
// ── WHAT IS ASKED, AND WHY THERE ARE THREE DECISION QUESTIONS ─────────────────────────
// Measured 2026-10-23 on laya 0.4.2 (labelled replies, quoted and unquoted): the 3-way
// choice alone answers `reject` with confidence 0.80 for "goedgekeurd" (Dutch: approved),
// 0.68 for "thanks" and 0.76 for "which repo is this?". No threshold catches a confidently
// wrong answer, so an approve also needs "does the reply clearly agree?" = agrees, and a
// reject also needs agrees = does_not_agree AND "is it a refusal?" = refusal (the agree
// question's negative side also covers thanks/questions, so it cannot protect a reject on its
// own), every one at >= 0.5. On 47 replies × quoted/unquoted that left ZERO wrong rejects and
// one debatable approve ("no problem"); the misses become "ask the user" (quoted) or "hand
// it to the agent" (unquoted). Rejects with a reason are often "unsure" — the user is asked
// for `2 <reason>`, which is the safe direction.
// A reply containing `?` is never decided: a question mark is a fact, not a judgement
// (laya is calibrated for judgement, not for presence facts).
//
// The extra-information question is a `choice` ("decision only" vs "decision plus
// information"), never `noul` (biased low). ⭐ It is the ONLY thing that decides whether the
// reply text becomes the decision's comment (George 2026-10-23): `decision_plus_information`
// at >= 0.5 ⇒ comment = the reply verbatim; anything else ⇒ decision only, no comment. No
// word count, no regex over the human's words. fr's own rules still apply on top
// (`toChatDecision`): a reject always carries a reason (decision-only ⇒ the bare-`no`
// grammar's default `REJECT_DEFAULT_REASON`), and an approve comment is never the ANSWER to a
// row that owes one (the bot asks for the answer, as for a bare `1`). A `question` records
// nothing at all (needInfoMessage), so it has no comment either.
//
// Every failure (no minter, no token, timeout, non-2xx, unparseable body) is `unavailable`:
// the caller records nothing.

import { getBundleTokenMinter } from './bundle-token-minter';

export const DEFAULT_LAYA_SYSTEMONE_URL = 'https://api.nonagentic.ai/laya/v1/systemone';
export const LAYA_SYSTEMONE_URL_ENV = 'LAYA_SYSTEMONE_URL';
/** Both decision questions must reach this (Jev choice confidence, 0..1). */
export const LAYA_DECISION_MIN_CONFIDENCE = 0.5;
const LAYA_TIMEOUT_MS = 8_000;
const COMMENT_MAX = 2_000;
export const LAYA_LOG_TAG = '[approval-reply-laya]';

export type ReplyInterpretation =
  | {
      kind: 'approve' | 'reject';
      /** The reply verbatim — set exactly when laya said "decision plus information". */
      comment?: string;
      /** laya said the reply carries information beyond the decision (>= 0.5). */
      layaSaysExtra: boolean;
    }
  | { kind: 'question' }
  /** Only when `allowUnrelated`: the reply is not about the approval. */
  | { kind: 'unrelated' }
  /** laya answered, but not clearly enough to record anything. */
  | { kind: 'unsure' }
  | { kind: 'unavailable'; reason: string };

export interface InterpretInput {
  tenantId: string;
  /** The approval's description (first lines are enough). */
  request: string;
  /** What the human wrote, tags already stripped. */
  reply: string;
  /** The reply did not quote the approval: add the `unrelated` option. */
  allowUnrelated: boolean;
  /** Overrides the default 8 s (the unquoted path, where the agent waits behind it). */
  timeoutMs?: number;
}

type Answer = { choice?: unknown; confidence?: unknown };

const DECISION_INSTRUCTIONS =
  'A person was asked to approve or reject the request and wrote the reply. ' +
  'Does the reply say yes, say no, or neither?';
const DECISION_CRITERIA: Record<string, string> = {
  approve:
    'The reply says yes to the request. Approving words in any language: approved, approve, yes, ok, ' +
    'okay, go ahead, ship it, looks good, LGTM, fine, agreed, sounds good, accepted, signed off, ' +
    'goedgekeurd, akkoord, ja, prima, a thumbs up. It may add a remark or an extra instruction and ' +
    'still be a yes.',
  reject:
    'The reply says no to the request. Refusing words in any language: rejected, reject, no, declined, ' +
    'do not proceed, stop, not acceptable, not yet, redo it, afgekeurd, nee, niet doen. It often gives ' +
    'a reason why the request must not go ahead.',
  question:
    'The reply neither says yes nor no: it asks a question, asks for more details or clarification, ' +
    'says thanks, hmm, or something unclear, or asks for some other work to be done.',
};
const UNRELATED_CRITERION =
  'The reply is not about the request at all: ordinary chat, a greeting, or a message about something else.';
const AGREES_QUESTION = {
  type: 'choice',
  instructions: 'Does the reply clearly agree to the request (a yes, in any language)?',
  criteria: {
    agrees:
      'The reply clearly says yes: approved, ok, go ahead, looks good, goedgekeurd, akkoord, ja, ' +
      'a thumbs up, possibly with an extra remark.',
    does_not_agree:
      'The reply does not clearly say yes: it refuses, hesitates, asks a question, thanks, or says ' +
      'something else.',
  },
};
/**
 * The reject corroboration. `agrees` cannot protect a reject: its `does_not_agree` side also
 * covers thanks / a question / something else, so it AGREES with exactly the wrong rejects
 * (third validator: quoted "thanks" read as reject 0.68 + does_not_agree ⇒ recorded). This
 * one has a separate `neither` side; measured 2026-10-23: 1 false refusal ("noted") in 16
 * non-refusals at >= 0.5, and that one still needs `decision=reject` too.
 */
const STANCE_QUESTION = {
  type: 'choice',
  instructions: 'Is the reply a refusal of the request?',
  criteria: {
    refusal:
      'A refusal: no, nope, rejected, declined, do not ship, stop, not yet, nee, afgekeurd, or a reason ' +
      'it must not go ahead.',
    acceptance: 'An acceptance: yes, approved, ok, looks good, goedgekeurd, akkoord.',
    neither:
      'Neither: thanks, noted, a question, a greeting, hmm, a plan for later, or a request for some other work.',
  },
};
const EXTRA_QUESTION = {
  type: 'choice',
  instructions: 'Besides saying yes or no, does the reply contain any other information?',
  criteria: {
    decision_only:
      'Nothing else: the reply is only a yes or a no (approved, ok, yes, go ahead, looks good, lgtm, ' +
      'no, rejected, a thumbs up), at most with thanks.',
    decision_plus_information:
      'Something else: the reply also gives a reason, a condition, an instruction, a request, an ' +
      'answer, a date, a name or any other detail.',
  },
};

/** The Jev request body. Exported for the tests. */
export function buildLayaRequest(input: Omit<InterpretInput, 'tenantId'>): Record<string, unknown> {
  const criteria = input.allowUnrelated
    ? { ...DECISION_CRITERIA, unrelated: UNRELATED_CRITERION }
    : DECISION_CRITERIA;
  return {
    model: 'jev-latest',
    state: { request: input.request.slice(0, 1_000), reply: input.reply.slice(0, COMMENT_MAX) },
    questions: {
      decision: { type: 'choice', instructions: DECISION_INSTRUCTIONS, criteria },
      agrees: AGREES_QUESTION,
      stance: STANCE_QUESTION,
      extra: EXTRA_QUESTION,
    },
  };
}

function readAnswer(a: unknown): { choice: string; confidence: number } | null {
  if (!a || typeof a !== 'object') return null;
  const { choice, confidence } = a as Answer;
  if (typeof choice !== 'string' || typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  return { choice, confidence };
}

/** The decision rule over laya's answers. Pure; exported for the tests. */
export function decideFromAnswers(
  answers: Record<string, unknown>,
  input: Pick<InterpretInput, 'reply' | 'allowUnrelated'>,
): ReplyInterpretation {
  const decision = readAnswer(answers.decision);
  const agrees = readAnswer(answers.agrees);
  const extra = readAnswer(answers.extra);
  const stance = readAnswer(answers.stance);
  if (!decision || !agrees || !stance) return { kind: 'unavailable', reason: 'unparseable_answers' };
  const min = LAYA_DECISION_MIN_CONFIDENCE;
  const sure = (a: { confidence: number }) => a.confidence >= min;

  if (input.allowUnrelated && decision.choice === 'unrelated') return { kind: 'unrelated' };
  // A question mark is a computed fact: the human asked something. Never decided.
  if (input.reply.includes('?')) return input.allowUnrelated ? { kind: 'unrelated' } : { kind: 'question' };

  const approve = decision.choice === 'approve' && sure(decision) && agrees.choice === 'agrees' && sure(agrees);
  const reject =
    decision.choice === 'reject' && sure(decision) &&
    agrees.choice === 'does_not_agree' && sure(agrees) &&
    stance.choice === 'refusal' && sure(stance);
  if (approve || reject) {
    // The second laya choice alone decides whether the words are kept (see the header).
    const layaSaysExtra = extra !== null && extra.choice === 'decision_plus_information' && sure(extra);
    const text = input.reply.trim().slice(0, COMMENT_MAX);
    return { kind: approve ? 'approve' : 'reject', ...(layaSaysExtra && text ? { comment: text } : {}), layaSaysExtra };
  }
  if (decision.choice === 'question' && sure(decision)) return { kind: 'question' };
  return { kind: 'unsure' };
}

/**
 * Ask laya what a free-text reply to an approval means. Never throws.
 *
 * ⭐ A THIN WRAPPER OVER {@link interpretChoice} — one transport, one credential, one place a
 * failure is classified. The approval menu is just one option set; it keeps its measured
 * corroboration (see this file's header) and every other seat reaches the same code.
 */
export async function interpretApprovalReply(input: InterpretInput): Promise<ReplyInterpretation> {
  const out = await interpretChoice({
    tenantId: input.tenantId,
    request: input.request,
    reply: input.reply,
    options: APPROVAL_CHOICES,
    allowUnrelated: input.allowUnrelated,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  switch (out.kind) {
    case 'unavailable':
      return { kind: 'unavailable', reason: out.reason };
    case 'unclear':
      return { kind: 'unsure' };
    case 'choice':
      if (out.choice === 'approve' || out.choice === 'reject') {
        return {
          kind: out.choice,
          ...(out.comment ? { comment: out.comment } : {}),
          layaSaysExtra: out.extras,
        };
      }
      if (out.choice === 'question') return { kind: 'question' };
      return { kind: input.allowUnrelated ? 'unrelated' : 'unsure' };
  }
}

/** The line in front of a decision read from free text: what fr understood. */
export function interpretedPreface(kind: 'approve' | 'reject', commentKept: boolean): string {
  const verb = kind === 'approve' ? 'an approval' : 'a rejection';
  return `I read your reply as ${verb}${commentKept ? ' and saved your words with it' : ''}.`;
}

/**
 * The comment recorded for a reject that carried no words of its own — the bare-`no` grammar
 * and laya's wordless reject both use it, because a reject always carries a reason.
 * ⛔ CHANNEL-NEUTRAL on
 * purpose: this module and `domain/engagement/channel-reply.ts` are the ONE reply flow for
 * every text channel, so the audit sentence must not name one of them (it read "Rejected via
 * Telegram" when Telegram owned the flow).
 */
export const REJECT_DEFAULT_REASON = 'Rejected from chat';

/** What `processDecision` records for a laya approve/reject. */
export type ChatDecision = { decision: 'approved' | 'rejected'; comment?: string };

/**
 * laya's approve/reject as the decision the chat seat records. A reject always carries a
 * reason (the reply, or the grammar's default). An approve keeps the reply as its comment —
 * except on a row that OWES an answer (`owesAnswer`), where a comment would BE the answer.
 */
export function toChatDecision(
  i: { kind: 'approve' | 'reject'; comment?: string; layaSaysExtra: boolean },
  owesAnswer: boolean,
): ChatDecision {
  // Only laya's "decision plus information" carries the words in (never a comment it did not ask for).
  const words = i.layaSaysExtra ? i.comment : undefined;
  if (i.kind === 'reject') return { decision: 'rejected', comment: words ?? REJECT_DEFAULT_REASON };
  // ⛔ Never the ANSWER: on a row that owes one, laya's "plus information" also counts an
  // instruction ("approved, go ahead with it" answering "which repo?"). The bot asks for the
  // answer instead, exactly as for a bare `1`.
  if (words && !owesAnswer) return { decision: 'approved', comment: words };
  return { decision: 'approved' };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ONE INTERPRETER FOR EVERY CHANNEL AND EVERY INPUT REQUEST
//
// George, 2026-10-31: "multi-cast (choices) -> receive message (decision) -> laya (which
// choice did the user make?) -> decision. this would apply to any channel and any type of
// external (user/agent) input request, laya also gives a score, so if the score is too low,
// you can automatically send the request again with the clarification that the response was
// not clear enough."
//
// So the choices WE SENT are the question, not a hard-coded taxonomy: a seat hands laya the
// option list it actually showed the human, plus the reply, and gets back which option was
// chosen and how sure laya is. Every text seat calls THIS — there is no second grammar to
// drift, and a channel that shows the same menu gets the same reading.
//
// ⛔ WHERE THE CORROBORATION STILL APPLIES, AND WHY. For the approval menu specifically,
// laya's single 3-way answer is NOT enough on its own: measured 2026-10-23 on laya 0.4.2 it
// answered `reject` at confidence 0.80 for "goedgekeurd" (Dutch: approved). So when — and
// only when — the option set contains `approve` and `reject`, the request also carries the
// `agrees` and `stance` questions and an approve/reject must corroborate. For any other
// option set the single answer plus its score is the whole rule.
//
// A LOW SCORE IS NOT A DECISION. `unclear` means the seat re-sends the request with
// {@link unclearChoiceMessage} and records nothing — on every channel, which is the point.

/** One option as it was rendered to the human. `id` is what fr acts on; `label` is what they saw. */
export interface ChoiceOption {
  id: string;
  /** The line the human read, e.g. `1 - Approve`. Fed to laya as the criterion's meaning. */
  label: string;
}

export type ChoiceInterpretation =
  | {
      kind: 'choice';
      /** One of `ChoiceOption.id`. */
      choice: string;
      confidence: number;
      /** The reply verbatim, set only when laya says it carries more than the decision. */
      comment?: string;
      /** laya said the reply carries information beyond the decision (>= threshold). */
      extras: boolean;
    }
  /** laya could not tell which option was chosen (or scored it too low). Record NOTHING; re-ask. */
  | { kind: 'unclear' }
  /** laya did not answer at all (no licence, timeout, non-200, unparseable). Record NOTHING. */
  | { kind: 'unavailable'; reason: string };

/** The approval menu as choices — the SAME three every text seat renders (approval-menu.ts). */
export const APPROVAL_CHOICES: readonly ChoiceOption[] = [
  { id: 'approve', label: '1 - Approve: the person approves the request' },
  { id: 'reject', label: '2 - Reject: the person refuses the request, usually with a reason' },
  { id: 'question', label: '3 - Question: the person neither approves nor rejects; they ask something instead' },
];

/** True for the approval menu — the one option set whose single answer needs corroborating. */
function needsCorroboration(options: readonly ChoiceOption[]): boolean {
  const ids = new Set(options.map((o) => o.id));
  return ids.has('approve') && ids.has('reject') && ids.has('question');
}

/** The Jev request body. Exported for the tests. */
export function buildChoiceRequest(input: {
  request: string;
  reply: string;
  options: readonly ChoiceOption[];
  allowUnrelated?: boolean;
}): Record<string, unknown> {
  // The approval menu keeps its measured question set (see the header) — INCLUDING when the
  // reply may be about something else: `buildLayaRequest` adds the `unrelated` option to the
  // SAME corroborated questions. ⛔ Gating this on `!allowUnrelated` would silently drop
  // `agrees`/`stance` on the unquoted path and let a lone 3-way score record a decision.
  if (needsCorroboration(input.options)) {
    return buildLayaRequest({
      request: input.request,
      reply: input.reply,
      allowUnrelated: input.allowUnrelated === true,
    });
  }
  const criteria: Record<string, string> = {};
  for (const o of input.options) criteria[o.id] = o.label;
  if (input.allowUnrelated) {
    criteria['unrelated'] = UNRELATED_CRITERION;
  }
  return {
    model: 'jev-latest',
    state: { request: input.request.slice(0, 1_000), reply: input.reply.slice(0, COMMENT_MAX) },
    questions: {
      choice: {
        type: 'choice',
        instructions: 'A person was shown these options and replied. Which option did they choose?',
        criteria,
      },
      extra: EXTRA_QUESTION,
    },
  };
}

/** The decision rule over laya's answers. Pure; exported for the tests. */
export function decideFromChoiceAnswers(
  answers: Record<string, unknown>,
  input: { reply: string; options: readonly ChoiceOption[]; allowUnrelated?: boolean },
): ChoiceInterpretation {
  if (needsCorroboration(input.options)) {
    // Identical rule to `decideFromAnswers`, so the approval reading cannot change by being
    // reached through this entry point.
    const out = decideFromAnswers(answers, { reply: input.reply, allowUnrelated: input.allowUnrelated === true });
    switch (out.kind) {
      case 'approve':
      case 'reject':
        return {
          kind: 'choice',
          choice: out.kind,
          confidence: readAnswer(answers.decision)?.confidence ?? 0,
          ...(out.comment ? { comment: out.comment } : {}),
          extras: out.layaSaysExtra,
        };
      case 'question':
        return { kind: 'choice', choice: 'question', confidence: readAnswer(answers.decision)?.confidence ?? 0, extras: false };
      case 'unrelated':
        return { kind: 'choice', choice: 'unrelated', confidence: 1, extras: false };
      case 'unsure':
        return { kind: 'unclear' };
      default:
        return { kind: 'unavailable', reason: out.kind === 'unavailable' ? out.reason : 'unexpected' };
    }
  }

  const chosen = readAnswer(answers.choice);
  if (chosen === null) return { kind: 'unavailable', reason: 'unparseable_answers' };
  if (chosen.confidence < LAYA_DECISION_MIN_CONFIDENCE) return { kind: 'unclear' };
  const known = input.options.find((o) => o.id === chosen.choice);
  if (known === undefined && !(input.allowUnrelated && chosen.choice === 'unrelated')) return { kind: 'unclear' };
  const extra = readAnswer(answers.extra);
  const extras = extra !== null && extra.choice === 'decision_plus_information' && extra.confidence >= LAYA_DECISION_MIN_CONFIDENCE;
  const text = input.reply.trim().slice(0, COMMENT_MAX);
  return {
    kind: 'choice',
    choice: chosen.choice,
    confidence: chosen.confidence,
    ...(extras && text ? { comment: text } : {}),
    extras,
  };
}

/**
 * Ask laya which option the person chose. Never throws: every failure is `unavailable`, and
 * the caller records nothing.
 */
export async function interpretChoice(input: {
  tenantId: string;
  /** The request as the human saw it. */
  request: string;
  /** What the human wrote, tags already stripped. */
  reply: string;
  /** The options the seat actually rendered. */
  options: readonly ChoiceOption[];
  allowUnrelated?: boolean;
  timeoutMs?: number;
}): Promise<ChoiceInterpretation> {
  const reply = input.reply.trim();
  if (!reply) return { kind: 'unclear' };
  let token: string | undefined;
  try {
    token = await getBundleTokenMinter('laya')?.token(input.tenantId);
  } catch {
    token = undefined;
  }
  if (!token) return { kind: 'unavailable', reason: 'no_laya_licence' };
  let res: Response;
  try {
    res = await fetch(process.env[LAYA_SYSTEMONE_URL_ENV]?.trim() || DEFAULT_LAYA_SYSTEMONE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(buildChoiceRequest({
        request: input.request,
        reply,
        options: input.options,
        ...(input.allowUnrelated ? { allowUnrelated: true } : {}),
      })),
      signal: AbortSignal.timeout(input.timeoutMs ?? LAYA_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.name : 'transport_error' };
  }
  if (res.status === 401) getBundleTokenMinter('laya')?.invalidate(input.tenantId, token);
  if (res.status !== 200) return { kind: 'unavailable', reason: `http_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'unavailable', reason: 'unparseable_body' };
  }
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return { kind: 'unavailable', reason: 'no_answers' };
  const out = decideFromChoiceAnswers(answers as Record<string, unknown>, {
    reply,
    options: input.options,
    ...(input.allowUnrelated ? { allowUnrelated: true } : {}),
  });
  console.info(
    `${LAYA_LOG_TAG} tenant=${input.tenantId} options=${input.options.map((o) => o.id).join('|')} ` +
      `outcome=${out.kind}${out.kind === 'choice' ? ` choice=${out.choice}:${out.confidence}` : ''}`,
  );
  return out;
}

/**
 * The re-ask a LOW SCORE earns: the same request, the same choices, and the reason it came
 * back — on whatever channel the human replied from.
 */
export function unclearChoiceMessage(lines: readonly string[]): string {
  return [
    `I couldn't tell which option you chose, so nothing was recorded.`,
    ``,
    ...lines,
  ].join('\n');
}
