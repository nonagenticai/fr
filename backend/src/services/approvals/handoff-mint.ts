// src/services/approvals/handoff-mint.ts
//
// P2.3 step 3 (C1-59) — the PURE half of POST /api/approvals/:id/mint-design-units: validate a
// decided A3's stored handoff.v2 contract and map it to one dev-card body per unit. No I/O, no
// clock, no randomness: the route (routes/approval-mint-design-units.ts) owns the reads + mints.
//
// THE REFERENCE IS ncn `scripts/lib/handoff-contract.mjs` (handoff.v2, ncn#2034) — `validateHandoff`
// and `toCardBodies`. Every refusal CODE below is spelled exactly as that lib spells it, so a
// violation reads the same on both sides. Ported here because the mint moved from n8n into fr
// (n8n cannot see the decider's kind, has no crypto, and its callback workflow is at its node
// budget).
//
// ncn's ctx, and where fr gets each part:
//   ctx.approval.{id,kind,design_hash,decided}  the approvals row + its stored decision
//   ctx.designDoc.hash                                   approvals.metadata.design_hash (the H_d the
//                                                        human approved, sealed into a3_inputs_hash)
//   ctx.designDoc.acceptance_criteria                    approvals.metadata.scenarios[].criterion_id —
//                                                        the design's AC list as minted on the A3
//   ctx.handoffOnDone                                    FEATURE_DEV_TYPES (fr's mint vocabulary: the
//                                                        strict schema already admits only these)
//
// ⚠️ KNOWN GAPS — NOT CHECKED HERE, AND SAID OUT LOUD (a test names each one):
//   * element_ids are checked STRUCTURALLY ONLY (non-empty strings). ncn refuses every element id
//     not in ctx.resolvedElementIds (element_unresolved); fr has NO requirements-element API to
//     resolve them against, so a well-formed but non-existent element id is ACCEPTED here.
//   * target_repo_not_private: ncn requires ctx.targetRepoVisibility === 'PRIVATE'; fr does not
//     read GitHub on this path, so repository visibility is NOT checked here.

import { canonicalizeJcs } from '../../lib/bug-report-hash';
import {
  HANDOFF_CONTRACT_VERSION,
  HANDOFF_FEATURE_DEV_TYPES,
  HANDOFF_UNIT_AC_MAX,
  HANDOFF_UNIT_AC_MIN,
  HANDOFF_UNIT_MAX,
  HANDOFF_UNIT_MIN,
  HandoffContractSchema,
  isCanonicalPath,
} from './handoff-contract';

/** ncn WRITE_SET_MAX (= fr write-set-paths.ts WRITE_SET_MAX). */
export const HANDOFF_WRITE_SET_MAX = 40;
export const HANDOFF_REPO_FIELDS = ['repository_url', 'branch', 'container_name', 'repo_name'] as const;
/** ncn RESERVED_UNIT_KEYS: set by the mint from validated contract-level values, never by a unit. */
export const HANDOFF_RESERVED_UNIT_KEYS = [
  'kind',
  'contract_ref',
  'decomposition_id',
  'design_hash',
  'design_approval_id',
  'unit_id',
  'dedupe_key',
  'parent_card_id',
  'card_inputs',
  'acceptance_criterion_ids',
  ...HANDOFF_REPO_FIELDS,
] as const;
/** ncn CARD_INPUT_KEYS — the EXACT key set of every minted card's description JSON (card_inputs). */
export const HANDOFF_CARD_INPUT_KEYS = [
  'acceptance_criterion_ids',
  'acceptance_tests',
  'branch',
  'container_name',
  'contract_ref',
  'design_approval_id',
  'design_hash',
  'kind',
  'repo_name',
  'repository_url',
  'scope',
  'unit',
] as const;
/** P2.3: asset_id prefix of a unit card (services/improvement-cards/dedup.ts A3_UNIT_ASSET_PREFIX). */
export const a3UnitAssetId = (approvalId: string, unitKey: string): string => `a3:${approvalId}:${unitKey}`;

/**
 * The parent binding. Every unit card is minted with parent_card_id = contract.design_card_id
 * (toCardBodies), and createProjectCardFor → linkParentChild writes THAT card's child_cards — it
 * never checks the parent. So the contract may only name the card the A3 was decided on:
 * returns null when `contract.design_card_id === approvalCardId` (a non-empty string), else the
 * reason it is not. A null/absent approval card can never match.
 */
export function designCardBindingRefusal(contract: unknown, approvalCardId: string | null | undefined): string | null {
  const named = isObj(contract) ? contract.design_card_id : undefined;
  if (!isStr(approvalCardId)) {
    return `the approval has no card_id, so handoff_contract.design_card_id ${JSON.stringify(named ?? null)} cannot be bound to it`;
  }
  if (named !== approvalCardId) {
    return `handoff_contract.design_card_id ${JSON.stringify(named ?? null)} is not the approval's design card ${JSON.stringify(approvalCardId)}`;
  }
  return null;
}

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/;
const CRIT_RE = /^crit_[0-9a-f]{8}$/;
const FUNC_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TEST_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+\.py$/;
const isTestPath = (p: unknown): p is string => typeof p === 'string' && TEST_PATH_RE.test(p) && isCanonicalPath(p);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
/** ncn pathKey: case-insensitive path identity (APFS / default Windows collapse case). */
const pathKey = (p: string): string => p.toLowerCase();

export interface HandoffViolation {
  unit: string;
  field: string;
  code: string;
  detail?: string;
}

export interface HandoffCardInputs {
  kind: string;
  contract_ref: { decomposition_id: string; unit_key: string };
  design_hash: string;
  design_approval_id: string;
  unit: { kind: 'new' | 'update'; file: string; function: string; insert_after?: string };
  scope: { target_files: string[] };
  acceptance_tests: Array<{ id: string; path: string; code: string }>;
  acceptance_criterion_ids: string[];
  repository_url: string;
  branch: string;
  container_name: string;
  repo_name: string;
}

export interface HandoffCardBody {
  unit_key: string;
  card_type: (typeof HANDOFF_FEATURE_DEV_TYPES)[number];
  card_name: string;
  /** The card's description: canonicalizeJcs(card_inputs) — a raw JSON object, the shape n8n's
   *  card hydration parses whole into `card_inputs` (as routes/decomposition-commit.ts writes). */
  description: string;
  card_inputs: HandoffCardInputs;
  asset_id: string;
  parent_card_id: string;
  /** Sibling unit_keys this unit requires; the route maps them to the minted card ids. */
  requires: string[];
}

export interface HandoffMintCtx {
  approval: { id: string; kind: string; design_hash: unknown; decided: boolean };
  /** The design H_d: its hash and its acceptance-criterion ids. */
  designDoc: { hash: unknown; criterion_ids: readonly string[] };
}

export type HandoffMintResult =
  | { ok: true; bodies: HandoffCardBody[] }
  | { ok: false; code: string; violations: HandoffViolation[] };

/** ncn schemaPointer: the JSON pointer of the first structurally malformed place, or null. */
function schemaPointer(c: unknown): string | null {
  if (!isObj(c)) return '';
  if (c.contract_version !== HANDOFF_CONTRACT_VERSION) return '/contract_version';
  if (!Array.isArray(c.units)) return '/units';
  for (let i = 0; i < c.units.length; i += 1) {
    const u = c.units[i];
    const p = `/units/${i}`;
    if (!isObj(u)) return p;
    if (!isStr(u.unit_key)) return `${p}/unit_key`;
    if (!isObj(u.scope)) return `${p}/scope`;
    if (!isStr(u.scope.summary) || u.scope.summary.length > 280) return `${p}/scope/summary`;
    if (!Array.isArray(u.scope.target_files) || !u.scope.target_files.every(isStr)) return `${p}/scope/target_files`;
    // element_ids: STRUCTURAL ONLY (see the header's KNOWN GAPS).
    if (!Array.isArray(u.scope.element_ids) || !u.scope.element_ids.every(isStr)) return `${p}/scope/element_ids`;
    if (!Array.isArray(u.interfaces)) return `${p}/interfaces`;
    for (let j = 0; j < u.interfaces.length; j += 1) {
      const f = u.interfaces[j];
      if (!isObj(f) || !['provides', 'consumes'].includes(f.direction) || !isStr(f.name) || typeof f.signature !== 'string') {
        return `${p}/interfaces/${j}`;
      }
    }
    if (!Array.isArray(u.acceptance_criteria)) return `${p}/acceptance_criteria`;
    for (let j = 0; j < u.acceptance_criteria.length; j += 1) {
      const a = u.acceptance_criteria[j];
      if (!isObj(a) || !CRIT_RE.test(typeof a.id === 'string' ? a.id : '') || !isStr(a.text)) {
        return `${p}/acceptance_criteria/${j}`;
      }
    }
    if (!Array.isArray(u.covers) || !u.covers.every(isStr)) return `${p}/covers`;
    if (typeof u.child_card_type !== 'string') return `${p}/child_card_type`;
    if (!Array.isArray(u.requires) || !u.requires.every(isStr)) return `${p}/requires`;
  }
  return null;
}

/** ncn topoOrder: Kahn's algorithm, ties broken by input position. */
function topoOrder(units: Array<{ unit_key: string; requires: string[] }>): { order: string[]; cyclic: string[] } {
  const keys = new Set(units.map((u) => u.unit_key));
  const indeg = new Map(units.map((u) => [u.unit_key, 0]));
  const out = new Map<string, string[]>(units.map((u) => [u.unit_key, []]));
  for (const u of units) {
    for (const r of u.requires) {
      if (keys.has(r)) {
        indeg.set(u.unit_key, (indeg.get(u.unit_key) ?? 0) + 1);
        out.get(r)!.push(u.unit_key);
      }
    }
  }
  const pos = new Map(units.map((u, i) => [u.unit_key, i]));
  const ready = units.filter((u) => indeg.get(u.unit_key) === 0).map((u) => u.unit_key);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => pos.get(a)! - pos.get(b)!);
    const k = ready.shift()!;
    order.push(k);
    for (const n of out.get(k)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) ready.push(n);
    }
  }
  return { order, cyclic: units.map((u) => u.unit_key).filter((k) => !order.includes(k)) };
}

/**
 * Validate the STORED contract (design_approval_id already injected by the caller) against ncn's
 * handoff.v2 rules, ALL-OR-NOTHING: any violation ⇒ `ok: false` and no bodies at all. On success,
 * the card bodies in topological (requires-first) order.
 */
export function validateHandoffForMint(contract: unknown, ctx: HandoffMintCtx): HandoffMintResult {
  const v: HandoffViolation[] = [];
  const add = (unit: string, field: string, code: string, detail?: string) =>
    v.push(detail ? { unit, field, code, detail } : { unit, field, code });
  const done = (): HandoffMintResult => ({ ok: false, code: v[0]!.code, violations: v });

  if (contract === null || contract === undefined) {
    add('-', 'contract', 'missing_contract');
    return done();
  }
  const ptr = schemaPointer(contract);
  if (ptr !== null) {
    add('-', ptr || '/', `schema_invalid:${ptr || '/'}`);
    return done();
  }
  const c = contract as Record<string, any>;
  for (const f of ['decomposition_id', 'design_card_id', 'producing_procedure', 'design_hash', ...HANDOFF_REPO_FIELDS]) {
    if (!isStr(c[f])) add('-', f, 'incomplete_contract');
  }
  const units = c.units as Array<Record<string, any>>;
  if (units.length < HANDOFF_UNIT_MIN || units.length > HANDOFF_UNIT_MAX) add('-', 'units', 'unit_count_out_of_range');

  const hdHash = ctx.designDoc.hash;
  const hdIds = new Set(ctx.designDoc.criterion_ids);
  const allowed: readonly string[] = HANDOFF_FEATURE_DEV_TYPES;
  const seen = new Set<string>();
  const keys = new Set(units.map((u) => u.unit_key as string));
  const covered = new Set<string>();
  const acOwner = new Map<string, string>();

  if (!isStr(hdHash) || ctx.approval.design_hash !== hdHash || c.design_hash !== hdHash) {
    add('-', 'design_hash', 'design_hash_mismatch');
  }
  if (ctx.approval.kind !== 'execution.feature_design_approval') add('-', 'approval.kind', 'approval_kind_invalid');
  if (ctx.approval.decided !== true) add('-', 'approval.decided', 'approval_not_decided');
  if (!isStr(c.design_approval_id)) add('-', 'design_approval_id', 'design_approval_id_missing');
  else if (!isStr(ctx.approval.id) || c.design_approval_id !== ctx.approval.id) {
    add('-', 'design_approval_id', 'design_approval_id_mismatch');
  }
  // target_repo_not_private: NOT checked here — see the header's KNOWN GAPS.

  const writeSet = new Set<string>();
  const testOwner = new Map<string, { k: string; p: string }>();
  const targetOwners = new Map<string, string[]>();
  const fnOwner = new Map<string, { k: string; file: string }>();
  const testPaths: Array<[string, string]> = [];
  for (const u of units) {
    const k = u.unit_key as string;
    if (seen.has(k)) add(k, 'unit_key', 'duplicate_child_key');
    seen.add(k);
    if (!KEY_RE.test(k)) add(k, 'unit_key', 'malformed_child_key');
    for (const r of HANDOFF_RESERVED_UNIT_KEYS) if (Object.hasOwn(u, r)) add(k, r, 'unit_overrides_contract_field');
    const t = u.child_card_type as string;
    if (!allowed.includes(t)) add(k, 'child_card_type', `child_type_not_allowed:${t}`);
    for (const cv of u.covers as string[]) {
      if (!hdIds.has(cv)) add(k, 'covers', 'dangling_claim');
      covered.add(cv);
    }
    for (const r of u.requires as string[]) if (!keys.has(r)) add(k, 'requires', 'dangling_dependency');
    // element_ids: STRUCTURAL ONLY (schemaPointer above). ncn's element_unresolved needs a
    // requirements element API that does not exist — see the header's KNOWN GAPS.
    const acs = u.acceptance_criteria as Array<{ id: string; text: string }>;
    if (acs.length < HANDOFF_UNIT_AC_MIN) add(k, 'acceptance_criteria', 'unit_acs_empty');
    else if (acs.length > HANDOFF_UNIT_AC_MAX) add(k, 'acceptance_criteria', 'unit_not_invest_small');
    if (!acs.every((a) => hdIds.has(a.id))) add(k, 'acceptance_criteria', 'acs_not_subset_of_hd');
    for (const id of new Set(acs.map((a) => a.id))) {
      if (acOwner.has(id) && acOwner.get(id) !== k) add(k, 'acceptance_criteria', 'criterion_in_multiple_units');
      else acOwner.set(id, k);
    }

    const un = u.unit;
    const unitOk =
      isObj(un) &&
      (un.kind === 'new' || un.kind === 'update') &&
      isCanonicalPath(un.file) &&
      typeof un.function === 'string' &&
      FUNC_RE.test(un.function) &&
      (un.insert_after === undefined ||
        un.insert_after === null ||
        (typeof un.insert_after === 'string' && FUNC_RE.test(un.insert_after)));
    if (!unitOk) add(k, 'unit', 'unit_invalid');
    if (unitOk) {
      const fk = `${pathKey(un.file)}\u0000${un.function}`;
      const prev = fnOwner.get(fk);
      if (prev) {
        add(
          k,
          'unit',
          'unit_function_duplicate',
          `${prev.file}::${un.function} is the unit of unit ${prev.k} and ${un.file}::${un.function} the unit of unit ${k}`,
        );
      } else fnOwner.set(fk, { k, file: un.file });
    }
    const tf = u.scope.target_files as string[];
    if (tf.length === 0) add(k, 'scope.target_files', 'target_files_empty');
    else if (!tf.every(isCanonicalPath)) add(k, 'scope.target_files', 'target_files_not_canonical');
    else if (new Set(tf.map(pathKey)).size !== tf.length) add(k, 'scope.target_files', 'target_files_duplicate');
    else if (!isObj(un) || tf[0] !== un.file) add(k, 'scope.target_files', 'target_files_head_not_unit_file');
    for (const f of tf) writeSet.add(f);
    for (const f of new Set([...(isObj(un) && typeof un.file === 'string' ? [un.file] : []), ...tf].map(pathKey))) {
      if (!targetOwners.has(f)) targetOwners.set(f, []);
      targetOwners.get(f)!.push(k);
    }
    const at = u.acceptance_tests;
    if (!Array.isArray(at) || at.length === 0) add(k, 'acceptance_tests', 'acceptance_tests_missing');
    else if (
      !at.every(
        (x) =>
          isObj(x) &&
          typeof x.id === 'string' &&
          CRIT_RE.test(x.id) &&
          isTestPath(x.path) &&
          typeof x.code === 'string' &&
          x.code.trim().length > 0,
      )
    ) {
      add(k, 'acceptance_tests', 'acceptance_test_invalid');
    } else {
      const unitAcIds = new Set(acs.map((a) => a.id));
      if (!at.every((x) => unitAcIds.has(x.id))) add(k, 'acceptance_tests', 'acceptance_test_unknown_criterion');
      const tested = new Set(at.map((x) => x.id as string));
      if (![...unitAcIds].every((id) => tested.has(id))) add(k, 'acceptance_tests', 'criterion_without_test');
      for (const p of at.map((x) => x.path as string)) {
        const pk = pathKey(p);
        const prev = testOwner.get(pk);
        if (prev) {
          add(
            k,
            'acceptance_tests',
            'acceptance_test_path_duplicate',
            `${p} is an acceptance test path of unit ${prev.k}${prev.p === p ? '' : ` (as ${prev.p})`} and of unit ${k}`,
          );
        } else testOwner.set(pk, { k, p });
        testPaths.push([p, k]);
        writeSet.add(p);
      }
    }
  }
  for (const [p, k] of testPaths) {
    const owners = targetOwners.get(pathKey(p));
    if (owners) {
      add(
        k,
        'acceptance_tests',
        'acceptance_test_path_collision',
        `${p} is an acceptance test path of unit ${k} and a target file of unit ${owners.join(', unit ')}`,
      );
    }
  }
  for (const id of hdIds) if (!covered.has(id)) add('-', 'covers', 'uncovered_criterion');
  for (const id of hdIds) if (!acOwner.has(id)) add('-', 'acceptance_criteria', 'hd_criterion_uncovered');
  if (writeSet.size > HANDOFF_WRITE_SET_MAX) add('-', 'write_set', 'write_set_over_budget');

  const { order, cyclic } = topoOrder(units as Array<{ unit_key: string; requires: string[] }>);
  if (cyclic.length) add(cyclic[0]!, 'requires', 'cyclic_dependency');

  // Belt and braces: fr's strict create-time schema over the stored value (an unknown key at any
  // level, a U+0000, a non-.py test path). Reported only when nothing above already refused.
  if (v.length === 0) {
    const strict = HandoffContractSchema.safeParse(c);
    if (!strict.success) {
      const issue = strict.error.issues[0]!;
      const p = `/${issue.path.join('/')}`;
      add('-', p, `schema_invalid:${p}`, issue.message);
    }
  }
  if (v.length) return done();

  const byKey = new Map(units.map((u) => [u.unit_key as string, u]));
  return {
    ok: true,
    bodies: toCardBodies(c, order.map((k) => byKey.get(k)!), String(hdHash), ctx.approval.id),
  };
}

/**
 * ncn toCardBodies: card_inputs is built EXPLICITLY from validated values (no unit spread), so it
 * carries exactly HANDOFF_CARD_INPUT_KEYS and no unit key can override a contract-level field.
 * No `red_test`. asset_id = a3:<approval id>:<unit_key> (the DONE-deduping prefix).
 */
function toCardBodies(
  contract: Record<string, any>,
  units: Array<Record<string, any>>,
  designHash: string,
  designApprovalId: string,
): HandoffCardBody[] {
  return units.map((u) => {
    const unit: HandoffCardInputs['unit'] = { kind: u.unit.kind, file: u.unit.file, function: u.unit.function };
    if (typeof u.unit.insert_after === 'string') unit.insert_after = u.unit.insert_after; // null/absent ⇒ append
    const card_inputs: HandoffCardInputs = {
      kind: `${u.child_card_type}_inputs`,
      contract_ref: { decomposition_id: contract.decomposition_id, unit_key: u.unit_key },
      design_hash: designHash,
      design_approval_id: designApprovalId,
      unit,
      scope: { target_files: [...u.scope.target_files] },
      acceptance_tests: u.acceptance_tests.map((t: any) => ({ id: t.id, path: t.path, code: t.code })),
      acceptance_criterion_ids: u.acceptance_criteria.map((a: any) => a.id),
      repository_url: contract.repository_url,
      branch: contract.branch,
      container_name: contract.container_name,
      repo_name: contract.repo_name,
    };
    return {
      unit_key: u.unit_key,
      card_type: u.child_card_type,
      card_name: String(u.scope.summary).slice(0, 200),
      description: canonicalizeJcs(card_inputs),
      card_inputs,
      asset_id: a3UnitAssetId(designApprovalId, u.unit_key),
      parent_card_id: contract.design_card_id,
      requires: [...u.requires],
    };
  });
}
