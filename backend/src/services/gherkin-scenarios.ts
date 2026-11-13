/**
 * `gherkin_scenarios` — the STRICT schema of the top-level array on a card's
 * description JSON (C1-58 D14 skeleton + R3 "repro contract v2" bug-path entry,
 * ~/.claude/plans/w53-scratch/R3-RESULT-SHAPE.md, amendment 2026-10-02 "repro
 * contract v2" + its "v2 rev (movies-13 10-02)" and "fr storage" bullets).
 *
 * ⛔ STRICT, NOT STRIP AND NOT `.catch()`. fr's usual body-schema precedent
 * (`z.object()` default strip + `.catch(undefined)`, routes/webhooks.ts) would
 * silently DROP a malformed or undeclared field — and for a repro entry a
 * dropped `test_file_content` / `test_file_sha256` turns every bug card into
 * `qa_needs_info:repro_malformed` at R3b, far from the write that caused it.
 * So an entry carrying an undeclared key, an over-cap test file, or a
 * mis-shaped field is REFUSED at the write (4xx + a coded error) and nothing
 * is written. The check itself never rewrites anything.
 *
 * STORAGE (coordinator ruling movies-13, 2026-10-02): `test_file_content` is
 * NEVER sent to Planka. POST /api/cards/project (`splitScenarioEvidence`)
 * removes it from the card document Planka gets — every other field stays,
 * `test_file_sha256` is the pointer — and stores the full entry in fr's
 * `card_scenario_evidence` (migration 154), read back by GET /api/cards/:id
 * as `scenario_evidence`. The paths that write a description straight to
 * Planka refuse an entry carrying it (`assertDescriptionScenarios`). Every
 * refusal body carries `qa_needs_info: "repro_malformed"`; fr never emits
 * `test_file_changed`.
 *
 * Census of writers before going strict (none sends an undeclared key):
 * ~/.claude/plans/w53-scratch/s1002-procedures/FR1338-writer-census.md.
 *
 * WHICH document is checked: exactly the one ncn's `activity-card-hydration ::
 * Hydrate Card Fields` reads as `card_inputs` — the first ```json fence, else
 * the whole description when it starts with `{`. A description that is not
 * that, or does not parse, carries no `gherkin_scenarios` the conveyor could
 * read, so it is not this check's business.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { type ScenarioLike, scenariosHash as canonicalScenariosHash } from '../lib/scenarios-hash';
import { AppError } from '../utils/errors';

/** Contract v2: `test_file_content` ≤ 32 KiB (R3b re-checks size + sha at QA). */
export const TEST_FILE_CONTENT_MAX = 32768;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * A UTF-16 code unit that is half of a surrogate pair with no other half.
 * `JSON.stringify` emits it as `\udXXX`, which Postgres `jsonb`/`text` refuse
 * ("Unicode low surrogate must follow a high surrogate") — so it would surface
 * as a 5xx from the evidence INSERT instead of a 400 here.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Storable in Postgres text/jsonb: no NUL (`\u0000`, refused by both) and no lone surrogate. */
export function isPgStorableText(s: string): boolean {
  return !s.includes('\u0000') && !LONE_SURROGATE.test(s);
}

const PG_TEXT_MESSAGE = 'must not contain NUL (\\u0000) or a lone UTF-16 surrogate (not storable)';
const PG_TEXT_PARAMS = { reason: 'not_pg_storable' } as const;
/** Every string in an entry is checked: the WHOLE entry is stored as jsonb. */
const pgText = <T extends z.ZodTypeAny>(t: T) =>
  t.refine((v: unknown) => typeof v !== 'string' || isPgStorableText(v), {
    message: PG_TEXT_MESSAGE,
    params: PG_TEXT_PARAMS,
  });
const TOO_LARGE_PARAMS = { reason: 'too_large' } as const;

/**
 * One entry. Identity + hashed fields (`scenario_id`, `criterion_id`, `title`,
 * `gherkin` — the canonical-scenarios-hash v1 allowlist) plus lifecycle
 * (`status`, `scenario_hash`) plus the contract-v2 EVIDENCE fields, which are
 * OUT of the scenario hash. Every evidence field is optional: the D14 skeleton
 * minted at commit carries none of them.
 *
 * `title` is deliberately UNCAPPED: the skeleton copies the acceptance-criterion
 * text verbatim and fr caps that nowhere, so a cap here would make fr refuse its
 * own mint. The array is uncapped for the same reason (one entry per criterion).
 */
export const GherkinScenarioEntry = z
  .object({
    scenario_id: z.string().regex(/^scn_[0-9a-f]{8}$/, 'scenario_id must be scn_<8 hex>'),
    criterion_id: z.string().regex(/^crit_[0-9a-f]{1,64}$/, 'criterion_id must be crit_<hex>'),
    title: pgText(z.string()).optional(),
    gherkin: pgText(z.string().max(20000)).nullable().optional(),
    status: z.string().regex(/^[a-z_]{1,50}$/, 'status must be a lowercase snake_case token').optional(),
    scenario_hash: z.string().regex(HEX64, 'scenario_hash must be 64 lowercase hex').optional(),
    // ── contract-v2 evidence (bug path) ──
    /** pytest node id; contract: starts with test_path + '::' and contains scenario_id (R3b checks). */
    failing_test: pgText(z.string().min(1).max(1024)).optional(),
    /** repo-relative, under tests/ (contract); no absolute path, no `..` segment. */
    test_path: pgText(
      z
        .string()
        .max(1024)
        .regex(/^tests\/[^\0]+$/, 'test_path must be repo-relative under tests/')
        .refine((p) => !p.split('/').includes('..'), 'test_path must not contain a .. segment'),
    ).optional(),
    /** sha256 of the exact UTF-8 bytes of test_file_content. */
    test_file_sha256: z.string().regex(HEX64, 'test_file_sha256 must be 64 lowercase hex').optional(),
    /**
     * The test file itself, INLINE. Capped twice: ≤ 32768 UTF-16 units (zod
     * max) AND ≤ 32768 UTF-8 bytes — the contract's "exact UTF-8 bytes, ≤ 32 KiB"
     * is a BYTE cap, and a multibyte file under the char cap would otherwise
     * pass here and be refused at R3b instead.
     */
    test_file_content: pgText(
      z
        .string()
        .max(TEST_FILE_CONTENT_MAX)
        .refine((s) => Buffer.byteLength(s, 'utf8') <= TEST_FILE_CONTENT_MAX, {
          message: `the scenario test-file content must be at most ${TEST_FILE_CONTENT_MAX} UTF-8 bytes`,
          params: TOO_LARGE_PARAMS,
        }),
    ).optional(),
    /** S0: the 40-hex git commit the repro is RED at. */
    base_sha: z.string().regex(HEX40, 'base_sha must be a 40-hex git sha').optional(),
    expect_red: z.boolean().optional(),
    runner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, 'runner must be a lowercase token').optional(),
  })
  .strict();

export type GherkinScenarioEntryT = z.infer<typeof GherkinScenarioEntry>;

/** The array. Duplicate `scenario_id` is refused: the canonical hash cannot hash it. */
export const GherkinScenarios = z.array(GherkinScenarioEntry).superRefine((arr, ctx) => {
  const seen = new Set<string>();
  arr.forEach((e, i) => {
    if (seen.has(e.scenario_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'scenario_id'],
        message: `duplicate scenario_id ${e.scenario_id}`,
      });
    }
    seen.add(e.scenario_id);
  });
});

export const SCENARIO_CODES = {
  tooLarge: 'gherkin_scenario_test_file_too_large',
  unknownKey: 'gherkin_scenario_unknown_key',
  invalid: 'gherkin_scenarios_invalid',
  shaMismatch: 'gherkin_scenario_test_file_sha256_mismatch',
  contentNotAcceptedHere: 'gherkin_scenario_evidence_field_not_accepted_here',
  /** NUL or a lone surrogate in an entry string: Postgres cannot store it. */
  notStorable: 'gherkin_scenario_text_not_storable',
  /**
   * FAIL-CLOSED backstop: the description carries a `test_file_content` key
   * that the parsed card document does not account for (no document parses,
   * or the key sits outside it — a second fence, prose, a nested object).
   * Unaccounted, it would be passed to Planka verbatim with no check at all.
   */
  evidenceOutsideDocument: 'gherkin_scenario_evidence_outside_document',
  /**
   * A supplied scenario hash is not the one fr RECOMPUTES from the scenario
   * content (canonical-scenarios-hash v1). 422, never trusted (coordinator
   * ruling B4, 2026-10-03). Same token R3b's tamper check emits as
   * `qa_needs_info:scenario_hash_mismatch`.
   */
  scenarioHashMismatch: 'scenario_hash_mismatch',
} as const;

/**
 * Every scenario refusal is, for R3b, a MALFORMED repro — never
 * `test_file_changed`, which keeps its one meaning ("the fix edited the
 * test"; coordinator ruling movies-13, 2026-10-02). fr emits no qa_needs_info
 * code of its own anywhere else; this is the hint a producer (U1) maps from.
 */
export const SCENARIO_REFUSAL_QA_NEEDS_INFO = 'repro_malformed' as const;

export interface ScenarioRefusal {
  code: (typeof SCENARIO_CODES)[keyof typeof SCENARIO_CODES];
  message: string;
  issues: z.ZodIssue[];
  /** HTTP status; absent ⇒ 400. Only a hash mismatch is 422 (well-formed, but not the content's hash). */
  status?: 422;
}

/** The HTTP status a refusal is returned with (400 unless the refusal names another). */
export function scenarioRefusalStatus(r: ScenarioRefusal): 400 | 422 {
  return r.status ?? 400;
}

/** At most this many candidate closing fences are tried (each try is one JSON.parse). */
const MAX_FENCE_CANDIDATES = 256;
const FENCE = '```';
/** The opening marker of an ncn sentinel region appended after a raw card document. */
const SENTINEL_START = /<!-- aa:[a-z0-9_-]+:start -->/i;

interface LocatedDocument {
  /** The parsed document; undefined when a candidate exists but nothing parses. */
  doc: unknown;
  /** [start, end) of the text the document came from (the whole fence, markers included). */
  span: [number, number] | null;
  fenced: boolean;
}

/**
 * Locate the card document BY STRUCTURE. The opener is the first ```json
 * fence (what hydration reads); the closer is the FIRST ``` after it at which
 * the enclosed text parses as JSON. A JSON string may legally hold ```
 * unescaped (a test file with a markdown docstring), so the first ``` is not
 * necessarily the closer: a truncated JSON value never parses (an open string
 * or unbalanced bracket), so the first candidate that parses is the real end.
 * Without a fence, a description that starts with `{` is the document.
 *
 * A raw document may be followed by SENTINEL REGIONS: ncn's
 * `subroutine-card-write-description` (Merge Block) appends
 * `\n\n<!-- aa:readied_brief:start -->…<!-- aa:readied_brief:end -->` after
 * the raw JSON head (region names `[a-z0-9_-]+`). When the whole description
 * does not parse, the text before the first `<!-- aa:<region>:start -->` is the
 * head; its span ends at the head's JSON text (trailing whitespace excluded),
 * so a rewrite replaces the head only and keeps the separator and every region
 * byte-for-byte. A head that does not parse is unparseable, as before.
 */
function locateCardDocument(description: unknown): LocatedDocument | null {
  if (typeof description !== 'string' || description.length === 0) return null;
  const opener = /```json\s*/i.exec(description);
  if (opener) {
    const found = fenceDocumentAt(description, opener.index, opener[0].length);
    return found ? { doc: found.doc, span: found.span, fenced: true } : { doc: undefined, span: null, fenced: true };
  }
  if (!description.trim().startsWith('{')) return null;
  try {
    return { doc: JSON.parse(description) as unknown, span: [0, description.length], fenced: false };
  } catch {
    /* not one JSON document — a raw head followed by sentinel regions? */
  }
  const sentinel = SENTINEL_START.exec(description);
  if (sentinel) {
    const head = description.slice(0, sentinel.index).trimEnd();
    try {
      return { doc: JSON.parse(head) as unknown, span: [0, head.length], fenced: false };
    } catch {
      /* the head itself does not parse */
    }
  }
  return { doc: undefined, span: null, fenced: false };
}

/** The card document hydration reads (first ```json fence, else a raw `{…}`), parsed; undefined if none. */
export function cardDocumentOf(description: unknown): unknown {
  return locateCardDocument(description)?.doc;
}

// ── evidence-key detection: STRUCTURE first, normalised text as the backstop ──
//
// ⛔ NO SUBSTRING PRE-FILTER. A JSON key may be written with escapes
// (`"test_file_content"`) and still PARSE to `test_file_content`; a gate on
// the raw literal returned "no key" for exactly that document and Planka got the
// file (third audit NO, 2026-10-02). Every decision below is made on parsed
// structure or on a DECODED copy of the text, never on the raw bytes.

/** The declared evidence keys: fr stores them (card_scenario_evidence); Planka never sees them. */
export const SCENARIO_EVIDENCE_KEYS = ['test_file_content'] as const;
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(SCENARIO_EVIDENCE_KEYS);

/**
 * How every refusal of this guard family NAMES the evidence field (fr#1359
 * follow-up). ⛔ A refusal must never spell the literal key: an agent or n8n
 * that posts the error text as a Planka comment would otherwise be refused by
 * the all-fields guard for quoting the refusal — a self-refusal loop. The
 * error `code`s carry no key and are unchanged.
 */
export const EVIDENCE_FIELD_PHRASE = 'the scenario test-file content field';

/** Zod issues with every evidence-key path segment and message mention replaced by the phrase. */
function redactEvidenceKeyIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  const redact = (t: string): string => {
    let out = t;
    for (const k of SCENARIO_EVIDENCE_KEYS) out = out.split(k).join(EVIDENCE_FIELD_PHRASE);
    return out;
  };
  return issues.map(
    (i) =>
      ({
        ...i,
        message: redact(i.message),
        path: i.path.map((seg) => (typeof seg === 'string' && EVIDENCE_KEYS.has(seg) ? EVIDENCE_FIELD_PHRASE : seg)),
      }) as z.ZodIssue,
  );
}

/** At most this many ```json openers are tried; text past an untried opener stays "outside" (fail closed). */
const MAX_FENCE_OPENERS = 64;

/** One parsed JSON document of a description and the text it came from. */
interface ParsedRegion {
  doc: unknown;
  span: [number, number];
  /** True only for the document the split operates on (`locateCardDocument`). */
  cardDocument: boolean;
}

/** Locate the closer of the ```json fence whose opener is [opStart, opStart+opLen) — see `locateCardDocument`. */
function fenceDocumentAt(description: string, opStart: number, opLen: number): ParsedRegion | null {
  const bodyStart = opStart + opLen;
  let at = description.indexOf(FENCE, bodyStart);
  for (let tries = 0; at !== -1 && tries < MAX_FENCE_CANDIDATES; tries++) {
    const text = description.slice(bodyStart, at);
    const last = text.trimEnd().slice(-1);
    if (last === '}' || last === ']') {
      try {
        return { doc: JSON.parse(text) as unknown, span: [opStart, at + FENCE.length], cardDocument: false };
      } catch {
        /* not the closer — try the next ``` */
      }
    }
    at = description.indexOf(FENCE, at + 1);
  }
  return null;
}

/**
 * EVERY JSON document a description carries, parsed: the whole description when
 * it parses as JSON (then it is the only region — any fence inside it sits in a
 * string value), else each ```json fence found by structure, in order and
 * non-overlapping. The first opener is hydration's card document (the one the
 * split strips); every later fence is just another document. A fence that never
 * parses is not a region: its text stays outside, under the text backstop.
 */
function parsedRegions(description: string): ParsedRegion[] {
  const loc = locateCardDocument(description);
  try {
    const doc = JSON.parse(description) as unknown;
    // A whole-JSON description is the card document only when hydration reads it
    // as such (no ```json opener inside a string). Otherwise nothing is allowed.
    return [{ doc, span: [0, description.length], cardDocument: loc !== null && !loc.fenced }];
  } catch {
    /* not one JSON document — look for fences */
  }
  const out: ParsedRegion[] = [];
  const opener = /```json\s*/gi;
  let first = true;
  for (let n = 0; n < MAX_FENCE_OPENERS; n++) {
    const m = opener.exec(description);
    if (m === null) break;
    const region = fenceDocumentAt(description, m.index, m[0].length);
    if (region) {
      region.cardDocument = first;
      out.push(region);
      opener.lastIndex = region.span[1];
    } else {
      opener.lastIndex = m.index + 1;
    }
    first = false;
  }
  return out;
}

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const JSON_SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
/** At most this many decode passes (a fixpoint is normally reached in one or two). */
const MAX_DECODE_PASSES = 8;

/**
 * Decode every JSON string escape (`\uXXXX` incl. surrogate pairs, `\/`, `\"`,
 * `\\`, …) in ONE left-to-right pass per round, repeated to a fixpoint, so a
 * key escaped once (`test_file_content`) or twice (`\\u0063`, pasted
 * JSON-in-JSON) reads as its name. Left-to-right matters: `\\u0063` is an
 * escaped backslash followed by text on the first pass, not `c`.
 */
export function normaliseJsonEscapes(text: string): string {
  let cur = text;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    const next = cur.replace(JSON_ESCAPE, (_m, hex: string | undefined, c: string | undefined) =>
      hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : JSON_SIMPLE_ESCAPES[c!]!,
    );
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Object/array nesting deeper than this is refused (fail closed); the walk never leans on the call stack. */
const MAX_NESTING_DEPTH = 256;
/** A string value is re-parsed as JSON at most this many levels deep; one more level is refused (fail closed). */
const MAX_STRING_PARSE_DEPTH = 8;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A string that is itself JSON — an object, an array, or a JSON string literal
 * (one more layer of stringification) — parsed; undefined for anything else.
 * `JSON.stringify(JSON.stringify(entry))` is a string value that parses to a
 * string that parses to the entry: both layers are followed.
 */
function nestedJson(s: string): unknown {
  const t = s.trimStart();
  const c = t[0];
  if (c !== '{' && c !== '[' && c !== '"') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return undefined; // not JSON — an ordinary string
  }
  return (v !== null && typeof v === 'object') || typeof v === 'string' ? v : undefined;
}

interface DocumentScan {
  /**
   * Why the document is refused, or false: `evidence_key` = a declared evidence
   * key somewhere the split cannot strip it; `nesting_limit` = a limit was hit
   * (fail closed, whether or not a key is present).
   */
  stray: false | 'evidence_key' | 'nesting_limit';
  /**
   * Per evidence name, the occurrences the split REMOVES: the key itself on a
   * top-level card-document `gherkin_scenarios[i]` entry, plus any mention
   * inside that key's own string value (the whole value is dropped with it).
   * Nothing else is accounted for — a mention in any other string value is not.
   */
  accounted: Map<string, number>;
}

interface Frame {
  v: unknown;
  /** Object/array nesting depth, string layers included. */
  depth: number;
  /** How many string → JSON re-parses led here; > 0 ⇒ never an allowed position. */
  strDepth: number;
  /** The card document's root object: its `gherkin_scenarios` entries are the only allowed position. */
  root: boolean;
  /** A direct `gherkin_scenarios[i]` entry of the card document (only ever at strDepth 0). */
  entry: boolean;
}

/**
 * The structural walk over one parsed document — ITERATIVE (explicit stack),
 * depth-capped, and recursing INTO string values that are themselves JSON
 * (fourth audit NO: `{"repro":"{\"test_file_content\":…}"}` and a description
 * that is a JSON *string* of the document both reached Planka, because one
 * more parse yields the real key). A key found through a nested string parse is
 * NEVER on a scenario entry: only the top-level card document's direct
 * `gherkin_scenarios[i]` fields may carry it (and only with `allowOnEntries`).
 */
function scanDocument(doc: unknown, allowOnEntries: boolean): DocumentScan {
  const accounted = new Map<string, number>(SCENARIO_EVIDENCE_KEYS.map((k) => [k, 0]));
  const refused: DocumentScan = { stray: 'evidence_key', accounted };
  const tooDeep: DocumentScan = { stray: 'nesting_limit', accounted };
  const stack: Frame[] = [{ v: doc, depth: 0, strDepth: 0, root: allowOnEntries && isPlainObject(doc), entry: false }];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.depth > MAX_NESTING_DEPTH) return tooDeep;
    const { v } = f;
    if (typeof v === 'string') {
      const inner = nestedJson(v);
      if (inner === undefined) continue;
      if (f.strDepth + 1 > MAX_STRING_PARSE_DEPTH) return tooDeep;
      stack.push({ v: inner, depth: f.depth + 1, strDepth: f.strDepth + 1, root: false, entry: false });
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, depth: f.depth + 1, strDepth: f.strDepth, root: false, entry: false });
      continue;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (EVIDENCE_KEYS.has(k)) {
        if (!f.entry) return refused;
        accounted.set(k, accounted.get(k)! + 1);
        if (typeof x === 'string') {
          // the value is dropped with the key; mentions inside it never reach Planka
          for (const name of SCENARIO_EVIDENCE_KEYS) {
            accounted.set(name, accounted.get(name)! + occurrences(normaliseJsonEscapes(x), name));
          }
          continue;
        }
      }
      if (f.root && k === 'gherkin_scenarios' && Array.isArray(x)) {
        for (const e of x) {
          stack.push({ v: e, depth: f.depth + 2, strDepth: 0, root: false, entry: isPlainObject(e) });
        }
        continue;
      }
      stack.push({ v: x, depth: f.depth + 1, strDepth: f.strDepth, root: false, entry: false });
    }
  }
  return { stray: false, accounted };
}

/**
 * THE evidence-key detector — one function for every caller, so they can never
 * disagree about what "carries an evidence key" means:
 *
 *   - the route-level backstop (`evidenceOutsideDocument`, below) passes
 *     `allowOnEntries: true`: a key is ACCOUNTED FOR when it sits only as a
 *     direct field of a `gherkin_scenarios[i]` entry of the card document,
 *     because the split can see and remove it there;
 *   - the Planka chokepoint (`services/planka/description-guard.ts`, which the
 *     Planka transport itself also runs) and the `routes/projects.ts` preflight
 *     pass `allowOnEntries: false`: post-split, no placement is acceptable.
 *
 * Two independent layers, each with ground the other does not cover:
 *
 *   1. STRUCTURE. Every JSON document the description carries is parsed
 *      (`parsedRegions`: the whole description if it is JSON, else every
 *      ```json fence) and walked (`scanDocument`: iterative, nesting capped at
 *      MAX_NESTING_DEPTH). Every STRING value — and a top-level string
 *      document — that is itself JSON is parsed and walked too, up to
 *      MAX_STRING_PARSE_DEPTH layers; a deeper layer is refused. A key EQUAL to
 *      a declared evidence key anywhere but a direct field of a top-level card
 *      document scenario entry ⇒ true; through a string layer it is never on an
 *      entry. Escapes are irrelevant here: `JSON.parse` has already decoded it.
 *   2. NORMALISED TEXT (fail closed). The text is decoded (`normaliseJsonEscapes`)
 *      and searched case-sensitively for each key NAME. Outside every parsed
 *      document, any occurrence is unaccounted (prose, YAML, an unparseable or
 *      non-json fence) ⇒ true. Inside a document, the decoded text must hold
 *      exactly as many occurrences as the split removes (the entry keys and
 *      their own values) — any other occurrence, a string value naming the key
 *      included, or one the parse DROPPED (a duplicate key: `JSON.parse` keeps
 *      the last `"extra"`, the bytes of the first still go to Planka) ⇒ true.
 *
 * Any exception inside the detector (a parser or walker failure, a limit) is a
 * refusal, never a 500 and never a pass: fail closed.
 *
 * OUT OF CONTRACT, by design: an evidence payload ENCODED so it is no longer
 * JSON text (base64, gzip, hex, …) carries no key and is invisible to a
 * key-based guard; this detector does not attempt entropy or size heuristics.
 */
export function hasScenarioEvidenceKey(
  description: unknown,
  opts: { allowOnEntries: boolean },
): boolean {
  return scenarioEvidenceVerdict(description, opts) !== null;
}

/**
 * Why a refusal happened (fr#1359): the same decision as `hasScenarioEvidenceKey`,
 * with the reason kept so an error can say what it actually refused.
 *   - `evidence_key`: a declared evidence key (or its name in decoded text)
 *     where nothing strips it;
 *   - `nesting_limit`: more than MAX_STRING_PARSE_DEPTH string layers or
 *     MAX_NESTING_DEPTH object/array levels — refused even with NO key present,
 *     because the walk cannot prove the rest of the value clean (fail closed);
 *   - `detector_error`: the detector itself threw (fail closed).
 * null ⇒ clean.
 */
export type ScenarioEvidenceReason = 'evidence_key' | 'nesting_limit' | 'detector_error';

export function scenarioEvidenceVerdict(
  description: unknown,
  opts: { allowOnEntries: boolean },
): ScenarioEvidenceReason | null {
  if (typeof description !== 'string' || description.length === 0) return null;
  try {
    return detectEvidenceKey(description, opts.allowOnEntries);
  } catch {
    return 'detector_error'; // RangeError, a parser/walker failure, anything: refuse
  }
}

function detectEvidenceKey(description: string, allowOnEntries: boolean): ScenarioEvidenceReason | null {
  const regions = parsedRegions(description);

  // 1. structure: the walk over every parsed document (string layers included)
  const scans: DocumentScan[] = [];
  for (const r of regions) {
    const scan = scanDocument(r.doc, allowOnEntries && r.cardDocument);
    if (scan.stray) return scan.stray;
    scans.push(scan);
  }

  // 2. normalised-text backstop
  let outside = '';
  let cursor = 0;
  for (const r of regions) {
    outside += description.slice(cursor, r.span[0]) + '\n';
    cursor = r.span[1];
  }
  outside += description.slice(cursor);
  const outsideNorm = normaliseJsonEscapes(outside);
  for (const name of SCENARIO_EVIDENCE_KEYS) {
    if (outsideNorm.includes(name)) return 'evidence_key';
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      const inText = occurrences(normaliseJsonEscapes(description.slice(r.span[0], r.span[1])), name);
      if (inText !== scans[i]!.accounted.get(name)) return 'evidence_key';
    }
  }
  return null;
}

/**
 * The message for a refusal that is NOT "a key was found" (fr#1359): the value
 * could not be proven free of evidence, so it is refused (fail closed).
 */
export function refusalReasonMessage(reason: Exclude<ScenarioEvidenceReason, 'evidence_key'>, field: string): string {
  return reason === 'nesting_limit'
    ? `${field} is nested past the evidence detector's limit (more than ${MAX_STRING_PARSE_DEPTH} JSON string ` +
        `layers or ${MAX_NESTING_DEPTH} object/array levels); it cannot be proven free of repro evidence ` +
        `(${EVIDENCE_FIELD_PHRASE}), so it ` +
        'is refused (fail closed). Nothing written'
    : `${field} could not be checked for repro evidence (${EVIDENCE_FIELD_PHRASE}; the evidence detector ` +
        'failed); refused (fail closed). ' +
        'Nothing written';
}

/**
 * FAIL CLOSED: the description mentions an evidence key the parsed document
 * does not account for. Accounted = the key appears only as a direct field of
 * a `gherkin_scenarios[i]` entry of the located document, and nowhere in the
 * text outside that document's span. Anything else — no document parses, a
 * second fence, the key in prose or nested elsewhere — is refused, because the
 * split cannot remove what it cannot see and Planka would get the file.
 */
function evidenceOutsideDocument(description: unknown): ScenarioRefusal | null {
  const stray = scenarioEvidenceVerdict(description, { allowOnEntries: true });
  if (stray === null) return null;
  if (stray !== 'evidence_key') {
    // fr#1359: a nesting / detector refusal is NOT a claim that a key is present.
    return {
      code: SCENARIO_CODES.evidenceOutsideDocument,
      message: refusalReasonMessage(stray, 'description'),
      issues: [],
    };
  }
  return {
    code: SCENARIO_CODES.evidenceOutsideDocument,
    message:
      `gherkin_scenarios: repro evidence (${EVIDENCE_FIELD_PHRASE}) appears outside the parsed card document ` +
      '(no ```json document ' +
      'parses, or the key sits in a second fence / prose / a nested object); it would reach Planka unchecked. ' +
      'Refused, nothing written',
    issues: [],
  };
}

/**
 * null ⇒ the description is acceptable (no `gherkin_scenarios`, or a valid one).
 * Otherwise the refusal, with the most specific code first:
 * evidence outside the document > over-cap test file > unstorable text >
 * undeclared key > anything else.
 */
export function checkDescriptionScenarios(description: unknown): ScenarioRefusal | null {
  const outside = evidenceOutsideDocument(description);
  if (outside) return outside;
  const doc = cardDocumentOf(description);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Object.prototype.hasOwnProperty.call(doc, 'gherkin_scenarios')) {
    return checkScenarioHashes(doc as Record<string, unknown>, []);
  }
  const raw = (doc as Record<string, unknown>).gherkin_scenarios;
  const r = GherkinScenarios.safeParse(raw);
  if (r.success) return checkScenarioHashes(doc as Record<string, unknown>, raw as Array<Record<string, unknown>>);
  const issues = r.error.issues;
  const reason = (i: z.ZodIssue) =>
    i.code === z.ZodIssueCode.custom ? (i.params as { reason?: string } | undefined)?.reason : undefined;
  const tooLarge = issues.some(
    (i) =>
      i.path[i.path.length - 1] === 'test_file_content' &&
      (i.code === z.ZodIssueCode.too_big || reason(i) === TOO_LARGE_PARAMS.reason),
  );
  const notStorable = issues.some((i) => reason(i) === PG_TEXT_PARAMS.reason);
  const unknownKey = issues.some((i) => i.code === z.ZodIssueCode.unrecognized_keys);
  const code = tooLarge
    ? SCENARIO_CODES.tooLarge
    : notStorable
      ? SCENARIO_CODES.notStorable
      : unknownKey
        ? SCENARIO_CODES.unknownKey
        : SCENARIO_CODES.invalid;
  const message = tooLarge
    ? `gherkin_scenarios: ${EVIDENCE_FIELD_PHRASE} exceeds ${TEST_FILE_CONTENT_MAX} bytes; refused, nothing written`
    : notStorable
      ? 'gherkin_scenarios: an entry string contains NUL (\\u0000) or a lone UTF-16 surrogate, which cannot be stored; refused, nothing written'
      : unknownKey
        ? 'gherkin_scenarios: an entry carries an undeclared key; refused (never stripped), nothing written'
        : 'gherkin_scenarios: an entry is malformed; refused, nothing written';
  return { code, message, issues: redactEvidenceKeyIssues(issues) };
}

/**
 * B4 (coordinator ruling 2026-10-03): a scenario hash on a write is accepted
 * ONLY when it equals the hash fr RECOMPUTES from the scenario content — never
 * a bare asserted hash. The function is canonical-scenarios-hash v1
 * (`lib/scenarios-hash.ts`), the same one U3 recomputes at mint and the same
 * vectors ncn's R3b `AA_CQ_HASH` is pinned to. Two carriers:
 *
 *   - `scenarios_check.scenario_hash` (card-document top level) — the FREEZE
 *     value R3b's tamper check reads (`AA_CQ_SCENARIOS` stored_hash) and
 *     recomputes over the card's WHOLE `gherkin_scenarios` set. Recomputed
 *     here over the same set (`[]` when the document carries none).
 *   - `gherkin_scenarios[i].scenario_hash` — per entry; no spec gives it a
 *     set-level meaning and an append (POST /api/cards/:id/scenario-evidence)
 *     sees only its own entries, so it is the canonical hash of the
 *     ONE-element set `[entry]`, stable under append.
 *
 * ABSENT (or null) ⇒ nothing is computed and nothing is added: freezing is
 * READY's act (r.ready.scenarios), and a hash stamped here at create would
 * freeze a skeleton whose gherkin READY has not authored yet. R3b treats a
 * missing hash as `scenario_hash_missing` (trust-on-first-use forbidden), so
 * absence never passes silently. PRESENT ⇒ it must equal the recomputation,
 * so the stored bytes ARE the recomputed value. The check never rewrites.
 */
function checkScenarioHashes(
  doc: Record<string, unknown>,
  scenarios: ReadonlyArray<Record<string, unknown>>,
): ScenarioRefusal | null {
  const issues: z.ZodIssue[] = [];
  const recompute = (set: ReadonlyArray<Record<string, unknown>>): string | null => {
    try {
      return canonicalScenariosHash(set as unknown as ScenarioLike[]);
    } catch {
      return null; // duplicate scenario_id — the schema refuses it first; never hashable
    }
  };
  const verify = (supplied: unknown, set: ReadonlyArray<Record<string, unknown>>, path: (string | number)[]) => {
    if (supplied === undefined || supplied === null) return;
    const want = recompute(set);
    if (want === null || supplied !== want) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path,
        message:
          want === null
            ? 'scenario_hash cannot be recomputed for this scenario set'
            : `scenario_hash must be the canonical-scenarios-hash v1 of the scenario content (${want})`,
      });
    }
  };
  scenarios.forEach((e, i) => {
    if (isPlainObject(e)) verify(e.scenario_hash, [e], ['gherkin_scenarios', i, 'scenario_hash']);
  });
  const check = doc.scenarios_check;
  if (isPlainObject(check)) verify(check.scenario_hash, scenarios, ['scenarios_check', 'scenario_hash']);
  if (issues.length === 0) return null;
  return {
    code: SCENARIO_CODES.scenarioHashMismatch,
    message:
      'gherkin_scenarios: a supplied scenario_hash is not the hash fr recomputes from the scenario content ' +
      '(canonical-scenarios-hash v1); refused, nothing written',
    issues,
    status: 422,
  };
}

/** The JSON body every write path returns for a refusal (status per `scenarioRefusalStatus`, `error` = `code`). */
export function scenarioRefusalBody(r: ScenarioRefusal): Record<string, unknown> {
  return {
    error: r.code,
    code: r.code,
    message: r.message,
    issues: r.issues,
    qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO,
  };
}

/**
 * Throwing form for the paths that write a description STRAIGHT to Planka
 * (kanban passthroughs, the agent intake action, the bridge commit): the strict
 * check, plus a refusal of any entry that carries `test_file_content` — the
 * file must never reach Planka, and only POST /api/cards/project and POST
 * /api/cards/:id/scenario-evidence split it into fr's own store. 400 + top-level `code` + `details.qa_needs_info`.
 */
export function assertDescriptionScenarios(description: unknown): void {
  const r = checkDescriptionScenarios(description) ?? contentNotAcceptedHere(description);
  if (r) {
    throw new AppError(scenarioRefusalStatus(r), r.message, {
      issues: r.issues,
      qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO,
    }).withCode(r.code);
  }
}

function scenariosOf(description: unknown): Array<Record<string, unknown>> | null {
  const doc = cardDocumentOf(description);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const arr = (doc as Record<string, unknown>).gherkin_scenarios;
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : null;
}

function contentNotAcceptedHere(description: unknown): ScenarioRefusal | null {
  const arr = scenariosOf(description);
  if (!arr || !arr.some((e) => e && typeof e === 'object' && SCENARIO_EVIDENCE_KEYS.some((k) => k in e))) return null;
  return {
    code: SCENARIO_CODES.contentNotAcceptedHere,
    message:
      `gherkin_scenarios: repro evidence (${EVIDENCE_FIELD_PHRASE}) is stored in fr only and never sent to ` +
      'Planka; ' +
      'mint the card through POST /api/cards/project, which splits it out. Nothing written.',
    issues: [],
  };
}

// ── evidence split: test_file_content → fr, never Planka ─────────────────────

export interface ScenarioEvidence {
  scenario_id: string;
  test_file_sha256: string;
  /** The entry AS SENT, test_file_content included. */
  entry: Record<string, unknown>;
}

/**
 * For a description that already passed `checkDescriptionScenarios`: pull
 * every entry's `test_file_content` out. Returns the description Planka gets
 * (the same card document with `test_file_content` REMOVED from each entry and
 * every other field kept, so `test_file_sha256` is the pointer) and the
 * evidence rows fr stores. A description with no `test_file_content` is
 * returned BYTE-IDENTICAL (no re-serialisation).
 *
 * Refuses (sha mismatch) when `test_file_sha256` is absent or is not the
 * sha256 of the content's UTF-8 bytes: a stored file the pointer does not name
 * would make R3b's own check fail for a reason that is not the fix's fault.
 */
function splitOrThrow(
  description: string | undefined,
): { description: string | undefined; evidence: ScenarioEvidence[] } {
  const arr = scenariosOf(description);
  if (!arr || !arr.some((e) => 'test_file_content' in e)) return { description, evidence: [] };
  const evidence: ScenarioEvidence[] = [];
  const stripped = arr.map((e, i) => {
    if (!('test_file_content' in e)) return e;
    const content = e.test_file_content as string;
    const want = createHash('sha256').update(content, 'utf8').digest('hex');
    if (e.test_file_sha256 !== want) {
      throw Object.assign(new Error('sha'), { index: i });
    }
    evidence.push({ scenario_id: e.scenario_id as string, test_file_sha256: want, entry: e });
    const { test_file_content: _drop, ...rest } = e;
    return rest;
  });
  return { description: rewriteScenarios(description as string, stripped), evidence };
}

/**
 * Re-serialise the located document with the stripped entries, in place of
 * the span it came from. Every backtick is written as the JSON escape
 * ``` (backticks only ever occur inside JSON strings, and the escape
 * decodes to the same character), so the rewritten fence can never contain
 * ``` — hydration's lazy first-``` match then reads exactly this document.
 */
function rewriteScenarios(description: string, scenarios: unknown[]): string {
  const loc = locateCardDocument(description)!;
  const next = { ...(loc.doc as Record<string, unknown>), gherkin_scenarios: scenarios };
  return writeCardDocument(description, loc, next);
}

/** Every backtick as its JSON escape (see `rewriteScenarios`). */
const noTicks = (json: string) => json.replace(/`/g, '\\u0060');

/**
 * Every `<!--` as its JSON escape `\u003c!--`. ncn (`AA_CQ_SCENARIOS`: split at
 * `<!-- aa:readied_brief:start -->`) and fr (`locateCardDocument`: the first
 * `<!-- aa:<region>:start -->`) both cut a raw head at the first sentinel, so
 * content carrying that literal would split its own document. `<` only ever
 * occurs inside JSON strings, and the escape decodes to the same character:
 * the parsed value — and therefore every hash — is unchanged.
 */
const noCommentOpeners = (json: string) => json.replace(/<!--/g, '\\u003c!--');

/** `next` in place of the located document's span; every byte outside the span is kept. */
function writeCardDocument(description: string, loc: LocatedDocument, next: Record<string, unknown>): string {
  if (loc.fenced) {
    const [start, end] = loc.span!;
    return (
      description.slice(0, start) +
      '```json\n' +
      noCommentOpeners(noTicks(JSON.stringify(next, null, 2))) +
      '\n```' +
      description.slice(end)
    );
  }
  // raw: the span is the whole description, or the head before ncn's sentinel regions
  const [start, end] = loc.span!;
  return description.slice(0, start) + noCommentOpeners(noTicks(JSON.stringify(next))) + description.slice(end);
}

/** See the doc comment on `splitOrThrow`; a sha mismatch comes back as a refusal. */
export function splitScenarioEvidence(
  description: string | undefined,
): { description: string | undefined; evidence: ScenarioEvidence[] } | { refusal: ScenarioRefusal } {
  // Fail closed on its own too: a split that cannot see the evidence must not
  // pass the description through as if there were none.
  const outside = evidenceOutsideDocument(description);
  if (outside) return { refusal: outside };
  try {
    return splitOrThrow(description);
  } catch (e) {
    const index = (e as { index?: number }).index;
    if (typeof index !== 'number') throw e;
    return {
      refusal: {
        code: SCENARIO_CODES.shaMismatch,
        message:
          `gherkin_scenarios[${index}]: test_file_sha256 must be the sha256 of the UTF-8 bytes of ` +
          `${EVIDENCE_FIELD_PHRASE}; ` +
          'refused, nothing written',
        issues: [],
      },
    };
  }
}

// ── append to an EXISTING card's document (POST /api/cards/:id/scenario-evidence) ──

/** Why an existing card's description cannot take an append. */
export const CARD_DOCUMENT_CODES = {
  /** a ```json fence, or a description starting with `{`, that does not parse */
  unparseable: 'card_document_unparseable',
  /** the card document is not a JSON object, or its `gherkin_scenarios` is not an array */
  notAppendable: 'card_document_not_appendable',
  /**
   * The append would change a scenario set whose `scenarios_check.scenario_hash`
   * is frozen on the card: the stored hash would no longer be the recomputed
   * one (B4). Refused; nothing appended.
   */
  scenarioHashMismatch: 'scenario_hash_mismatch',
} as const;

export type AppendScenarioEntriesResult =
  | {
      /** The description Planka gets; byte-identical to the input when nothing is appended. */
      description: string;
      /** scenario_ids appended to the document by this call. */
      appended: string[];
      /** scenario_ids whose IDENTICAL entry the document already carries (never duplicated). */
      alreadyOnCard: string[];
    }
  | { conflict: string[] }
  | { refusal: { code: (typeof CARD_DOCUMENT_CODES)[keyof typeof CARD_DOCUMENT_CODES]; message: string } };

/**
 * Append evidence-STRIPPED `gherkin_scenarios` entries (no `test_file_content`;
 * `test_file_sha256` is the pointer) to the card document of an EXISTING
 * card's description — the document hydration reads (first ```json fence, else
 * a description that starts with `{`).
 *
 *   - An entry whose scenario_id the document already carries with an IDENTICAL
 *     entry (key order ignored) is not appended again (`alreadyOnCard`).
 *   - One the document carries with a DIFFERENT entry ⇒ `conflict` (the caller
 *     refuses; the document is never rewritten to a second meaning).
 *   - A fenced document is rewritten IN ITS SPAN only: every byte before and
 *     after the fence is kept. A raw-JSON description is re-serialised whole
 *     (compact; JSON whitespace is not preserved) — only its head when ncn
 *     sentinel regions follow it, which are kept byte-for-byte. A description with no
 *     document (empty, or prose) gets one: the empty description BECOMES the
 *     JSON document, prose is kept verbatim with a ```json fence appended.
 *   - A document that does not parse, is not an object, or whose
 *     `gherkin_scenarios` is not an array ⇒ `refusal` (nothing is guessed).
 *
 * Nothing appended ⇒ the input string is returned unchanged.
 */
export function appendScenarioEntries(
  description: string | null | undefined,
  entries: ReadonlyArray<Record<string, unknown>>,
): AppendScenarioEntriesResult {
  const current = typeof description === 'string' ? description : '';
  const loc = locateCardDocument(current);
  let doc: Record<string, unknown> = {};
  let existing: Array<Record<string, unknown>> = [];
  if (loc) {
    if (loc.doc === undefined) {
      return {
        refusal: {
          code: CARD_DOCUMENT_CODES.unparseable,
          message: "the card's description carries a card document that does not parse as JSON; nothing appended",
        },
      };
    }
    if (!isPlainObject(loc.doc)) {
      return {
        refusal: {
          code: CARD_DOCUMENT_CODES.notAppendable,
          message: "the card's document is not a JSON object; nothing appended",
        },
      };
    }
    doc = loc.doc;
    if (Object.prototype.hasOwnProperty.call(doc, 'gherkin_scenarios')) {
      const arr = doc.gherkin_scenarios;
      if (!Array.isArray(arr)) {
        return {
          refusal: {
            code: CARD_DOCUMENT_CODES.notAppendable,
            message: "the card's gherkin_scenarios is not an array; nothing appended",
          },
        };
      }
      existing = arr as Array<Record<string, unknown>>;
    }
  }
  const onCard = new Map<string, Record<string, unknown>>();
  for (const e of existing) {
    if (isPlainObject(e) && typeof e.scenario_id === 'string') onCard.set(e.scenario_id, e);
  }
  const appended: string[] = [];
  const alreadyOnCard: string[] = [];
  const conflict: string[] = [];
  const toAppend: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const id = String(e.scenario_id);
    const there = onCard.get(id);
    if (there === undefined) {
      toAppend.push(e);
      appended.push(id);
    } else if (canon(there) === canon(e)) {
      alreadyOnCard.push(id);
    } else {
      conflict.push(id);
    }
  }
  if (conflict.length > 0) return { conflict };
  if (toAppend.length === 0) return { description: current, appended, alreadyOnCard };
  const next = { ...doc, gherkin_scenarios: [...existing, ...toAppend] };
  if (checkScenarioHashes(next, next.gherkin_scenarios)) {
    return {
      refusal: {
        code: CARD_DOCUMENT_CODES.scenarioHashMismatch,
        message:
          "the append would make a scenario_hash on the card's document differ from the hash fr recomputes " +
          '(the scenario set is frozen); nothing appended',
      },
    };
  }
  let out: string;
  if (loc) {
    out = writeCardDocument(current, loc, next);
  } else if (current.trim() === '') {
    out = noCommentOpeners(noTicks(JSON.stringify(next)));
  } else {
    out = current + '\n\n```json\n' + noCommentOpeners(noTicks(JSON.stringify(next, null, 2))) + '\n```';
  }
  return { description: out, appended, alreadyOnCard };
}

// ── freeze an EXISTING card's scenario set (READY's act, r.ready.scenarios) ──

/** Why a freeze is refused. */
export const SCENARIO_FREEZE_CODES = {
  frozen: 'scenarios_frozen',
  skeletonMissing: 'scenarios_skeleton_missing',
  pairsDiffer: 'scenario_freeze_pairs_differ',
  titleChanged: 'scenario_freeze_title_changed',
  fieldChanged: 'scenario_freeze_field_changed',
  criterionIdNotCanonical: 'scenario_freeze_criterion_id_not_canonical',
  /**
   * The card's ncn `readied_brief` fence carries its OWN scenario set (a
   * non-empty `gherkin_scenarios`) or a `scenarios_check.scenario_hash` other
   * than the one being frozen. ncn's QA reader takes the brief FIRST, so it
   * would grade a second set / a different hash than the one fr froze (409).
   */
  briefConflict: 'scenarios_brief_conflict',
  /**
   * Replay path: the card's STORED `gherkin_scenarios` (missing, empty, or
   * edited outside fr) no longer hashes to its frozen
   * `scenarios_check.scenario_hash`. QA would read `mismatch` (or no set), so
   * a replay never reports `unchanged` over it (409).
   */
  storedHashMismatch: 'scenarios_stored_hash_mismatch',
  /**
   * The description starts with a raw JSON head (what ncn's QA reader takes)
   * but fr's locator found a LATER ```json fence (e.g. inside a sentinel
   * region) as the card document. The two readers disagree on which document
   * is the card's, so a freeze of either is refused (422).
   */
  documentAmbiguous: 'card_document_ambiguous',
} as const;

/**
 * ncn's readied_brief locator, CHARACTER FOR CHARACTER: n8n_custom_nodes
 * scripts/lib/coding-qa-verdict.mjs `AA_CQ_SCENARIOS` (`F = /```readied_brief\s*([\s\S]*?)```/`,
 * first match, `JSON.parse(F[1])`). Any change there must be mirrored here and
 * in tests/unit/services/_ncn-cq-reader.ts.
 */
const NCN_READIED_BRIEF_FENCE = /```readied_brief\s*([\s\S]*?)```/;

/**
 * The refusal for a description whose readied_brief would SHADOW the frozen
 * head in ncn's QA reader, or null when the brief cannot shadow it.
 *
 *   (a) a non-empty `gherkin_scenarios` array in the brief ⇒ ncn grades THAT
 *       set, not the head's;
 *   (b) a brief `scenarios_check` object whose `scenario_hash` is a string that
 *       differs from `scenarioHash` ⇒ ncn compares against THAT hash.
 *
 *   (c) a brief `scenarios_check` that is an object but not a plain one (an
 *       array: ncn takes ANY object as the brief's scenarios_check, hiding the
 *       head's hash ⇒ `missing`), or a plain one with an OWN `scenario_hash`
 *       that is not a string (number, null, object).
 *
 * A brief `scenarios_check` WITHOUT a `scenario_hash` key is allowed here, although
 * ncn then takes the stored hash from the brief's scenarios_check (absent ⇒
 * Validation.scenario_hash ⇒ else null ⇒ `missing`), NEVER from the head:
 * ncn's READY writer must put the frozen hash into the brief's
 * `scenarios_check` (or ncn's reader must take set + hash from the SAME
 * document) — coding-qa-verdict.mjs `AA_CQ_SCENARIOS`. fr does not write the
 * brief (it is ncn's sentinel region, kept byte-for-byte).
 *
 * A brief that does not parse as a JSON object is treated as carrying no
 * scenario data. ncn's reader (`P(F[1])` ⇒ null) then takes set + hash from the
 * raw head — the frozen document — or, when the head has no set, reports the
 * set UNKNOWN (`known: false` ⇒ `scenarios_unknown` at QA), which is
 * fail-closed; either way it cannot shadow the freeze into a false pass.
 */
function briefShadowRefusal(description: string, scenarioHash: string): FreezeScenarioSetResult | null {
  const m = NCN_READIED_BRIEF_FENCE.exec(description);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch {
    return null; // ncn falls back to the head, or scenarios_unknown (fail-closed); see the doc comment
  }
  if (!isPlainObject(parsed)) return null;
  const brief = parsed;
  const briefSet = brief.gherkin_scenarios;
  if (Array.isArray(briefSet) && briefSet.length > 0) {
    return {
      kind: 'refusal',
      code: SCENARIO_FREEZE_CODES.briefConflict,
      status: 409,
      message:
        "the card's readied_brief carries its own non-empty gherkin_scenarios; ncn's QA reads the brief FIRST, " +
        'so QA would grade that second set, not the one frozen on the card document; nothing written',
    };
  }
  const bc = brief.scenarios_check;
  const malformed =
    (bc !== null && typeof bc === 'object' && !isPlainObject(bc)) ||
    (isPlainObject(bc) && Object.prototype.hasOwnProperty.call(bc, 'scenario_hash') && typeof bc.scenario_hash !== 'string');
  if (malformed) {
    return {
      kind: 'refusal',
      code: SCENARIO_FREEZE_CODES.briefConflict,
      status: 409,
      message:
        "the card's readied_brief carries a malformed scenarios_check (not a plain object, or a non-string " +
        "scenario_hash); ncn's QA reads the brief FIRST, so it would hide the frozen hash; nothing written",
    };
  }
  if (isPlainObject(bc) && typeof bc.scenario_hash === 'string' && bc.scenario_hash !== scenarioHash) {
    return {
      kind: 'refusal',
      code: SCENARIO_FREEZE_CODES.briefConflict,
      status: 409,
      message:
        "the card's readied_brief carries scenarios_check.scenario_hash " +
        `${bc.scenario_hash}, not the hash being frozen (${scenarioHash}); ncn's QA reads the brief FIRST, ` +
        'so QA would compare against that different hash; nothing written',
    };
  }
  return null;
}

export type FreezeScenarioSetResult =
  | { kind: 'frozen'; description: string; scenarioCount: number }
  | { kind: 'unchanged'; scenarioCount: number }
  | { kind: 'conflict'; storedHash: string }
  | { kind: 'refusal'; code: string; message: string; status: 409 | 422; issues?: unknown[] };

/**
 * ncn's coding-qa-verdict only counts ids of EXACTLY these widths; any other
 * width is a permanent mismatch at R3b. (The entry schema admits crit_<1..64
 * hex> — a freeze is stricter on purpose.)
 */
const FREEZE_SCENARIO_ID = /^scn_[0-9a-f]{8}$/;
const FREEZE_CRITERION_ID = /^crit_[0-9a-f]{8}$/;
/** Keys the merge decides explicitly; every other sent key must equal the stored value. */
const FREEZE_MERGED_KEYS: ReadonlySet<string> = new Set(['scenario_id', 'criterion_id', 'title', 'gherkin', 'status']);

/**
 * Freeze the card's scenario set: merge the sent entries (gherkin authored,
 * `pending` → `frozen`) onto the STORED skeleton and write
 * `scenarios_check.scenario_hash`. The caller has ALREADY verified that
 * `scenarioHash` is the canonical-scenarios-hash v1 of `sent`.
 *
 *   - stored hash === `scenarioHash` ⇒ `unchanged` (idempotent, no rewrite);
 *     a different stored hash ⇒ `conflict` (a frozen set is never re-frozen).
 *     Before `unchanged`, the STORED set is re-hashed: a missing/empty set, or
 *     one that throws or hashes differently (edited outside fr), is refused 409
 *     `scenarios_stored_hash_mismatch`; then the brief-shadow check runs.
 *   - The sent set must name EXACTLY the stored {scenario_id, criterion_id}
 *     pairs with the stored titles; a freeze authors gherkin, it never
 *     reshapes the set.
 *   - Each merged entry starts from the STORED one (evidence pointers such as
 *     `test_file_sha256` / `failing_test` are kept), in stored order. A stored
 *     null gherkin takes the sent one; a stored non-null gherkin must be sent
 *     identical. Status may stay, or go `pending` → `frozen`. Any other sent
 *     key that differs from the stored value is refused.
 *   - Written via `writeCardDocument`, so a fence's surroundings and ncn's
 *     sentinel regions after a raw head are kept byte-for-byte; the result is
 *     re-checked with `checkScenarioHashes` before it is returned.
 *   - ncn's QA reader (coding-qa-verdict.mjs `AA_CQ_SCENARIOS`) reads the
 *     ```readied_brief fence FIRST: before `frozen` AND before `unchanged`, a
 *     brief with a non-empty `gherkin_scenarios`, or a `scenarios_check.scenario_hash`
 *     other than `scenarioHash`, is refused 409 `scenarios_brief_conflict`
 *     (see `briefShadowRefusal` — a brief `scenarios_check` without a hash is
 *     allowed, and ncn's READY writer owes the frozen hash into it). On `frozen`
 *     the check runs on the input AND on the WRITTEN description (fr's 200
 *     describes what ncn reads on the output bytes); on `unchanged` the stored
 *     description is the output.
 *   - A description that starts with a raw JSON head while the locator found a
 *     later ```json fence ⇒ 422 `card_document_ambiguous` (ncn reads the head,
 *     fr the fence).
 *   - A FENCED (```json) document stays freezable: fr and DOING hydration treat
 *     the fence as canonical. ncn's reader does not yet fall back to the fence
 *     (runbook blocker B6, owner phase-10), so until it does QA returns a null
 *     hash-state for such a card.
 */
export function freezeScenarioSet(
  description: string | null | undefined,
  sent: ReadonlyArray<Record<string, unknown>>,
  scenarioHash: string,
): FreezeScenarioSetResult {
  const current = typeof description === 'string' ? description : '';
  const refuse = (code: string, message: string, status: 409 | 422 = 422, issues?: unknown[]): FreezeScenarioSetResult =>
    issues ? { kind: 'refusal', code, message, status, issues } : { kind: 'refusal', code, message, status };
  const skeletonMissing = (): FreezeScenarioSetResult =>
    refuse(
      SCENARIO_FREEZE_CODES.skeletonMissing,
      "the card's document carries no gherkin_scenarios skeleton to freeze; nothing written",
      409,
    );

  // 1. the document
  const loc = locateCardDocument(current);
  if (!loc) return skeletonMissing();
  // A raw JSON head AND a later ```json fence: ncn's QA reader takes the head,
  // fr's locator (hydration semantics: first ```json fence wins) the fence.
  // Freezing either would leave the other reader on an unfrozen document.
  if (loc.fenced && current.trim().startsWith('{')) {
    return refuse(
      SCENARIO_FREEZE_CODES.documentAmbiguous,
      "the raw JSON head and a later ```json fence both look like the card document; ncn reads the head, fr's " +
        'locator the fence; refused rather than freeze the wrong one; nothing written',
    );
  }
  if (loc.doc === undefined) {
    return refuse(
      CARD_DOCUMENT_CODES.unparseable,
      "the card's description carries a card document that does not parse as JSON; nothing written",
    );
  }
  if (!isPlainObject(loc.doc)) {
    return refuse(CARD_DOCUMENT_CODES.notAppendable, "the card's document is not a JSON object; nothing written");
  }
  const doc = loc.doc;

  // 2. an already-frozen set
  const check = isPlainObject(doc.scenarios_check) ? doc.scenarios_check : undefined;
  const storedRaw = doc.gherkin_scenarios;
  if (check && typeof check.scenario_hash === 'string') {
    if (check.scenario_hash === scenarioHash) {
      // A replay must not report success over a stored set that no longer
      // hashes to the frozen value (edited outside fr), nor an empty/missing one.
      let recomputed: string | null = null;
      if (Array.isArray(storedRaw) && storedRaw.length > 0) {
        try {
          recomputed = canonicalScenariosHash(storedRaw as unknown as ScenarioLike[]);
        } catch {
          recomputed = null; // a duplicate id, a non-object entry, a non-string gherkin
        }
      }
      if (recomputed !== check.scenario_hash) {
        return refuse(
          SCENARIO_FREEZE_CODES.storedHashMismatch,
          "the card's stored scenario set no longer hashes to its frozen scenario_hash (edited outside fr); " +
            'QA would read mismatch; nothing written',
          409,
        );
      }
      // Nor over stored ids ncn's reader drops: it keeps only scn_/crit_ of
      // exactly 8 hex, so a wider/narrower id hashes a SUBSET (mismatch) or
      // nothing (null) at QA even though the whole set re-hashes correctly here.
      const nonCanonical = (storedRaw as unknown[]).some(
        (e) =>
          !isPlainObject(e) ||
          typeof e.scenario_id !== 'string' ||
          !FREEZE_SCENARIO_ID.test(e.scenario_id) ||
          typeof e.criterion_id !== 'string' ||
          !FREEZE_CRITERION_ID.test(e.criterion_id),
      );
      if (nonCanonical) {
        return refuse(
          SCENARIO_FREEZE_CODES.storedHashMismatch,
          "the card's stored scenario set carries a scenario_id/criterion_id that is not scn_/crit_<8 hex>; " +
            "ncn's QA reader drops it and would read mismatch; nothing written",
          409,
        );
      }
      // Nor over a brief that shadows the head. Nothing is written on a replay,
      // so the stored description IS the output ncn reads: this is the
      // output-side check as well.
      const shadow = briefShadowRefusal(current, scenarioHash);
      if (shadow) return shadow;
      return { kind: 'unchanged', scenarioCount: Array.isArray(storedRaw) ? storedRaw.length : sent.length };
    }
    return { kind: 'conflict', storedHash: check.scenario_hash };
  }

  // 3. the skeleton
  if (storedRaw !== undefined && storedRaw !== null && !Array.isArray(storedRaw)) {
    return refuse(CARD_DOCUMENT_CODES.notAppendable, "the card's gherkin_scenarios is not an array; nothing written");
  }
  const stored = (storedRaw ?? []) as unknown[];
  if (stored.length === 0) return skeletonMissing();

  // 4. canonical id widths, on both sides
  const badIds: string[] = [];
  const idsOk = (side: string, arr: ReadonlyArray<unknown>) =>
    arr.forEach((e, i) => {
      const ok =
        isPlainObject(e) &&
        typeof e.scenario_id === 'string' &&
        FREEZE_SCENARIO_ID.test(e.scenario_id) &&
        typeof e.criterion_id === 'string' &&
        FREEZE_CRITERION_ID.test(e.criterion_id);
      if (!ok) badIds.push(`${side}[${i}]`);
    });
  idsOk('sent', sent);
  idsOk('stored', stored);
  if (badIds.length > 0) {
    return refuse(
      SCENARIO_FREEZE_CODES.criterionIdNotCanonical,
      `scenario_id must be scn_<8 hex> and criterion_id crit_<8 hex> (${badIds.join(', ')}); nothing written`,
    );
  }
  const storedEntries = stored as Array<Record<string, unknown>>;

  // 5. same pairs, same titles
  const pairKey = (e: Record<string, unknown>) => `${String(e.scenario_id)} ${String(e.criterion_id)}`;
  const storedPairs = new Set(storedEntries.map(pairKey));
  const sentPairs = new Set(sent.map(pairKey));
  const storedIds = new Set(storedEntries.map((e) => String(e.scenario_id)));
  const sentById = new Map(sent.map((e) => [String(e.scenario_id), e]));
  const pairsEqual =
    storedPairs.size === storedEntries.length &&
    sentPairs.size === sent.length &&
    storedIds.size === storedEntries.length &&
    sentById.size === sent.length &&
    storedPairs.size === sentPairs.size &&
    [...sentPairs].every((p) => storedPairs.has(p));
  if (!pairsEqual) {
    return refuse(
      SCENARIO_FREEZE_CODES.pairsDiffer,
      'the sent {scenario_id, criterion_id} pairs are not exactly the stored ones (or repeat one); nothing written',
    );
  }
  const retitled = storedEntries
    .filter((e) => sentById.get(String(e.scenario_id))!.title !== e.title)
    .map((e) => String(e.scenario_id));
  if (retitled.length > 0) {
    return refuse(
      SCENARIO_FREEZE_CODES.titleChanged,
      `a freeze never changes a scenario title (${retitled.join(', ')}); nothing written`,
    );
  }

  // 6. merge onto the stored entries, in stored order
  const changed: string[] = [];
  const merged = storedEntries.map((st) => {
    const id = String(st.scenario_id);
    const se = sentById.get(id)!;
    const out: Record<string, unknown> = { ...st };
    if (st.gherkin === null || st.gherkin === undefined) {
      if (se.gherkin !== undefined) {
        if (se.gherkin !== null && typeof se.gherkin !== 'string') changed.push(`${id}.gherkin`);
        else out.gherkin = se.gherkin;
      }
    } else if (se.gherkin !== st.gherkin) {
      changed.push(`${id}.gherkin`);
    }
    if (se.status !== undefined && se.status !== st.status && !(st.status === 'pending' && se.status === 'frozen')) {
      changed.push(`${id}.status`);
    } else if (se.status !== undefined) {
      out.status = se.status;
    }
    for (const k of Object.keys(se)) {
      if (FREEZE_MERGED_KEYS.has(k)) continue;
      if (canon(se[k]) !== canon(st[k])) changed.push(`${id}.${k}`);
    }
    return out;
  });
  if (changed.length > 0) {
    return refuse(
      SCENARIO_FREEZE_CODES.fieldChanged,
      `a freeze may only author a null gherkin and move status pending → frozen; changed: ${changed.join(', ')}; ` +
        'nothing written',
    );
  }

  // 7. write the freeze value
  const next = {
    ...doc,
    gherkin_scenarios: merged,
    scenarios_check: { ...(check ?? {}), scenario_hash: scenarioHash },
  };

  // 8. prove it: the written hash must be the one fr recomputes (unreachable when the caller verified it)
  const proof = checkScenarioHashes(next, merged);
  if (proof) return refuse(proof.code, proof.message, 422, proof.issues);

  // 9. the readied_brief must not shadow what was just frozen (ncn reads it first)
  const shadow = briefShadowRefusal(current, scenarioHash);
  if (shadow) return shadow;

  // 10. ...on the WRITTEN bytes too: fr's 200 must describe what ncn reads on the
  // output, not the input. The rewrite escapes every backtick in the document, so
  // a fake ```readied_brief inside the stored document (which made ncn's lazy
  // regex miss the real brief on the INPUT) no longer exists on the OUTPUT, and
  // ncn then reads the real brief there.
  const written = writeCardDocument(current, loc, next);
  const writtenShadow = briefShadowRefusal(written, scenarioHash);
  if (writtenShadow) return writtenShadow;

  return { kind: 'frozen', description: written, scenarioCount: merged.length };
}

// ── canonical-scenarios-hash v1 ──────────────────────────────────────────────
//
// ONE implementation (fr#1395): `lib/scenarios-hash.ts`, vector-tested against the
// vendored spec (tests/fixtures/canonical-scenarios-hash/). Re-exported here so
// existing importers of this module keep their names; there is no second copy.
//
// ⛔ EXPLICIT ALLOWLIST: the hash projects each entry onto exactly these four keys
// (lib/scenarios-hash.ts canonicalScenariosString). Every other field — status,
// scenario_hash, and ALL contract-v2 evidence — is OUT. The four keys are
// scenario_id, criterion_id, title, gherkin; the behavioural pin is the
// golden vectors + the "evidence OUT" tests.

export { canonicalScenariosString, normaliseGherkin, scenariosHash } from '../lib/scenarios-hash';

/**
 * WHOLE-ENTRY canonical JSON (every key, sorted, recursive). NOT the hash path:
 * used only for the append idempotency check (appendScenarioEntries) and the
 * freeze field-changed check (freezeScenarioSet), where ANY key difference counts.
 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
