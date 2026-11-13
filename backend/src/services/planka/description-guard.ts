// services/planka/description-guard.ts
//
// THE Planka write-body chokepoint (fr#1338 follow-up; widened to every string
// field by fr#1359). Repro evidence
// (`test_file_content`, up to 32 KiB) lives ONLY in fr's
// `card_scenario_evidence` table and must never reach Planka.
//
// The route-level check (`assertDescriptionScenarios` / `checkDescriptionScenarios`
// + `splitScenarioEvidence`) produces the right 400 early on the routes that
// call it, but a route-level check covers exactly the routes someone remembered
// to wire: four card writers did not call it (projects intake brief, the
// stream manual-trigger card, the improvement-card mint, the project intake
// card) and the assets/kanban MOVE passthrough forwards a raw request body.
// So the refusal also lives HERE, called by everything that puts a body on the
// wire — `CardsResource.create/update` (services/planka), the `PlankaHttp`
// transport itself for EVERY non-GET whatever its path (services/planka/http.ts),
// and the kanban transport for EVERY non-GET body (`KANBAN_TRANSPORT` behind
// `http()` in integrations/kanban.ts; createCard/updateCard also call it
// themselves) — and an import-level census
// (tests/unit/services/planka/description-chokepoint-coverage.test.ts) pins that
// no module outside those transports can write to Planka.
//
// ⭐ fr#1359: EVERY STRING IN THE BODY, NOT ONLY `description`. Comment `text`,
// card/task/list names, custom-field values and names all reached Planka
// unchecked when this guarded only the description. The walk below visits every
// string VALUE and every object KEY of the body, recursively, and runs the same
// detector over each. The rule is the same for every field: `allowOnEntries:
// false`, i.e. post-split NO placement of the key is acceptable anywhere — the
// card-document `description` is not special here, because the only legitimate
// home of the key (a top-level `gherkin_scenarios[]` entry) is stripped by
// `splitScenarioEvidence` before any body is built. Prod measured 2026-10-02
// (read-only): 0 card names, comments, tasks, task lists, custom-field values or
// names and project descriptions carry the key, literal or escaped.
//
// Detection is STRUCTURAL (every parsed JSON document walked recursively) with
// a normalised-text backstop — see `hasScenarioEvidenceKey`. There is no raw
// substring pre-filter: an escaped key (`"test_file_\u0063ontent"`) parses to
// the real key and must be refused like the literal one.
//
// It is defense-in-depth: the error is an AppError(400) carrying the same code
// the backstop uses, so a route surfaces it as 400
// `gherkin_scenario_evidence_outside_document` through `handleError`, and it is
// deliberately NOT a PlankaError — the catch blocks that map PlankaError to a
// 502 (`planka_intake_failed` etc.) must not re-label it, and nothing may
// swallow it into a silent write.

import {
  EVIDENCE_FIELD_PHRASE,
  refusalReasonMessage,
  scenarioEvidenceVerdict,
  SCENARIO_CODES,
  SCENARIO_REFUSAL_QA_NEEDS_INFO,
  type ScenarioEvidenceReason,
} from '../gherkin-scenarios';
import { AppError } from '../../utils/errors';

/** The body object/array nesting beyond which the walk refuses (fail closed), as the detector does. */
const MAX_BODY_DEPTH = 256;
/** A field path in an error is cut to this many characters (keys are caller-supplied). */
const MAX_FIELD_LABEL = 200;

/** Where in the body a refusal was found. */
export interface PlankaBodyRefusal {
  /** Dotted path of the offending field (`text`, `customFieldValues[0].content`); `(body)` for a string body. */
  field: string;
  /** `value`: the string at `field`; `key`: the object key that ends `field`. */
  location: 'value' | 'key';
  reason: ScenarioEvidenceReason;
}

export class PlankaDescriptionEvidenceError extends AppError {
  readonly field: string;
  readonly reason: ScenarioEvidenceReason;

  constructor(refusal: PlankaBodyRefusal = { field: 'description', location: 'value', reason: 'evidence_key' }) {
    const { field, location, reason } = refusal;
    super(
      400,
      reason === 'evidence_key'
        ? `Planka write ${location === 'key' ? 'object at' : 'field'} \`${field}\` carries repro evidence ` +
            `(${EVIDENCE_FIELD_PHRASE}); repro evidence is stored in fr only and is never sent to Planka. ` +
            'Refused, nothing written'
        : refusalReasonMessage(reason, `Planka write field \`${field}\``),
      { issues: [], qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO, field, location, reason },
    );
    this.name = 'PlankaDescriptionEvidenceError';
    this.field = field;
    this.reason = reason;
    this.withCode(SCENARIO_CODES.evidenceOutsideDocument);
  }
}

const label = (path: string): string =>
  path.length <= MAX_FIELD_LABEL ? path : path.slice(0, MAX_FIELD_LABEL) + '…';
const childPath = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/**
 * The whole-body walk (fr#1359): every string VALUE and every object KEY of
 * `body`, recursively (iterative, depth-capped), through the evidence detector
 * with `allowOnEntries: false`. The first refusal found, or null. A string
 * body (an unparseable raw wire body) is itself checked.
 */
export function plankaBodyEvidenceRefusal(body: unknown): PlankaBodyRefusal | null {
  const check = (s: string, path: string, location: PlankaBodyRefusal['location']): PlankaBodyRefusal | null => {
    const reason = scenarioEvidenceVerdict(s, { allowOnEntries: false });
    return reason === null ? null : { field: label(path === '' ? '(body)' : path), location, reason };
  };
  const stack: Array<{ v: unknown; path: string; depth: number }> = [{ v: body, path: '', depth: 0 }];
  while (stack.length > 0) {
    const { v, path, depth } = stack.pop()!;
    if (typeof v === 'string') {
      const r = check(v, path, 'value');
      if (r) return r;
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    if (depth >= MAX_BODY_DEPTH) return { field: label(path === '' ? '(body)' : path), location: 'value', reason: 'nesting_limit' };
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: `${path}[${i}]`, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, x] = entries[i]!;
      // The field of a KEY refusal is the object that holds the key, never a
      // path ending in the key: the refusal text must not spell it (fr#1359).
      const kr = check(k, path, 'key');
      if (kr) return kr;
      stack.push({ v: x, path: childPath(path, k), depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Throw `PlankaDescriptionEvidenceError` when ANY string field (value or key,
 * at any depth) of the body about to be sent to Planka carries a declared
 * evidence key, escaped or not, or cannot be proven clean (nesting limit,
 * detector failure — fail closed). The error names the field and the reason.
 * Takes the BODY, so a passthrough whose static type says "no description"
 * (moveCard) is still checked at runtime. Call it before the request is built,
 * never after.
 */
export function assertPlankaCardBodyCarriesNoEvidence(body: unknown): void {
  const refusal = plankaBodyEvidenceRefusal(body);
  if (refusal) throw new PlankaDescriptionEvidenceError(refusal);
}
