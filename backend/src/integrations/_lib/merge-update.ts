// merge-update.ts
//
// TURN A PARTIAL UPDATE INTO A SAFE WHOLE-BODY PUT.
//
// ## Why this exists — the upstream REPLACES, it does not merge
//
// `requirements_management` applies a PUT by walking the SCHEMA's fields, not
// the request body's keys (`src/services/entity_service.py`, `EntityService.update`):
//
//     json_data = payload.model_dump(mode="json")          # no exclude_unset
//     for field_name in type(payload).model_fields:        # the SCHEMA, not the body
//         if field_name in self.server_managed or ...:
//             continue
//         setattr(obj, field_name, json_data[field_name])
//
// `model_dump` is taken WITHOUT `exclude_unset`, so a field the client omitted
// still appears in `json_data` — carrying its pydantic default, which for every
// optional column is `None`. The loop then writes that `None` over the stored
// value. The only fields spared are `SERVER_MANAGED_FIELDS` (same module: id,
// slug, tenant_id, subject_id, visibility, created_at, updated_at, tsv) and a
// schema's own `KEEP_IF_OMITTED` fields.
//
// ⇒ ANY KEY ABSENT FROM fr's REQUEST BODY IS BLANKED UPSTREAM.
//
// fr's editor builds its body from `manifest.editor.sections` alone, so a field
// no section offers is simply not in the payload.
//
// The fix is a read-modify-write: GET the row, lift the fields the `*In` schema
// accepts, overlay the caller's partial body, PUT the whole thing.
//
// ## The cost — ONE EXTRA GET PER WRITE
//
// Every converted `update*` makes at least two upstream round-trips instead of
// one. RM does serve PATCH on decisions, principles and requirements, but that
// PATCH REFUSES `origin_kind` / `origin_project_id` (422, `governed_asset_service.py`
// `GOVERNED_PATCH_ONLY`) — which fr's governed PUT legitimately carries — so it
// cannot carry fr's write; the architecture, TOC and UML resources have no PATCH.
// If the GET fails the write does not happen (blanking half a row is worse than
// refusing).
//
// ## Concurrent writers — closed where RM offers a precondition, open where not
//
// Between our GET and our PUT another writer can commit; a plain PUT would then
// carry the row as it looked BEFORE their change and silently revert it.
//
// * MODELING ROWS (ArchiMate elements and views, view objects and connections,
//   every UML row): RM checks `If-Match` against the head of the row's MODEL
//   (`services/modeling_models.py` `check_if_match`, 412 `stale_head`), and the
//   snapshot declares it on each of those PUTs. fr's read-modify-write there goes
//   through `mergeUnderModelHead` (integrations/architecture.ts): it reads the
//   row, then the model's head, then the row again, merges onto that second
//   read and sends the head as `If-Match` — any write after the head was read
//   moves it and the PUT is refused, never applied over. A caller that sent its
//   own `If-Match` (an editor holding a copy) has THAT value forwarded instead,
//   so its stale copy is refused rather than refreshed behind its back. A 412 is
//   relayed in plain words and never retried.
// * A modeling row with no model (`model_id` null, legacy rows) and every
//   other RM resource (decisions, principles, requirements, standards, TOC trees
//   and nodes): RM declares no `If-Match` and `EntityService.update` takes no
//   version precondition, so there is nothing to send. The window between the
//   GET and the PUT stays open there; closing it needs an RM change.

/**
 * Keys that must NEVER be carried over from the current row, even when the
 * `*In` schema accepts them.
 *
 * ⛔ Each entry is here because PRESERVING it is the harm — this is the one
 * thing the read-modify-write could newly break, so the default is the deny
 * list and callers opt out explicitly or not at all.
 *
 * - `risk_score` — upstream RECOMPUTES it, but only when it arrives as `null`.
 *   `requirements_management/src/schemas/pm.py` `RiskIn.compute_risk_score`:
 *
 *       @model_validator(mode="after")
 *       def compute_risk_score(self) -> "RiskIn":
 *           if self.risk_score is None:
 *               self.risk_score = self.probability * self.impact_score
 *
 *   Echo a stale score back and the recompute is skipped, so the score FREEZES
 *   while `probability` and `impact_score` go on changing.
 *
 * ⚠️ CORRECTED 2026-10-29: `created_by_user_id` / `creator_id` were on this list
 * ("echoing the author entrenches fr#1296"). Dropping them did not record the
 * EDITOR — it blanked the AUTHOR on every save of a decision, principle or
 * requirement, which is the very data loss this helper exists to stop. RM's own
 * partial update keeps them (`entity_service.py` `patch`: the merged record
 * starts from every stored `in_schema` field), so preserving is RM's semantics.
 */
export const NEVER_PRESERVE: ReadonlySet<string> = new Set(['risk_score']);

/**
 * Stored fields that are only VALID together with the stored value of another
 * field, keyed dependent → its sources. When the caller's edit CHANGES a source
 * (a defined value different from the stored one) and does not itself name the
 * dependent, the dependent is NOT carried over from the stored row: RM then
 * derives it, or the caller's new value stands on its own, instead of the
 * stale stored value contradicting the edit.
 *
 * - `layer` ← `element_type`: RM derives the ArchiMate layer from the type when
 *   `layer` is omitted, and refuses a layer that disagrees with the type (422
 *   `model_integrity` AM-TYP-001; `schemas/architecture.py`
 *   `ArchitectureElementIn._layer_follows_type`). Carrying the stored layer
 *   over a retype turned every "change the type" edit into that 422.
 * - `origin_project_id` / `origin_workflow_run_id` ← `origin_kind`: RM requires
 *   both null for `tenant`, the project id for `project` and the run id for
 *   `workflow` (`schemas/common.py` `OriginFieldsInMixin.check_origin_consistency`),
 *   so the stored pair of the OLD kind cannot travel with a new kind.
 */
export const DERIVED_ON_CHANGE: Readonly<Record<string, readonly string[]>> = {
  layer: ['element_type'],
  origin_project_id: ['origin_kind'],
  origin_workflow_run_id: ['origin_kind'],
};

/**
 * Compile-time proof that a runtime key list is EXACTLY the property set of a
 * generated `*In` type: a key the type has and the list lacks, or the reverse,
 * makes the argument `never` and the call a type error.
 */
type ExactKeyList<T, K extends readonly string[]> = [Exclude<keyof T, K[number]>] extends [never]
  ? [Exclude<K[number], keyof T>] extends [never]
    ? K
    : never
  : never;

/**
 * The keys a replacing PUT of `T` accepts, from the GENERATED
 * `PUT_BODY_PROPERTIES` (written by `tooling/openapi/generate-clients.ts` from
 * the committed snapshot), checked against the generated interface:
 *
 *     const DECISION_IN_KEYS = bodyKeysOf<DecisionIn>()(PUT_BODY_PROPERTIES.DecisionIn);
 *
 * Never a hand-typed list: an upstream field appears here the moment the
 * snapshot is regenerated, and is then carried through every save.
 */
export function bodyKeysOf<T>() {
  return <const K extends readonly string[]>(keys: K & ExactKeyList<T, K>): readonly string[] => keys;
}

/**
 * Build the whole-body PUT payload for a replacing upstream.
 *
 * @param readCurrent  Reads the row as it stands. Normally the module's own
 *                     `get*` function — `() => getActivity(eid)` — so the GET
 *                     goes through the same client, tenant headers, timeouts and
 *                     `IntegrationError` mapping as everything else, and a 404
 *                     or an auth failure surfaces unchanged to the route's
 *                     `handle()`.
 * @param patch        The caller's partial body. It wins on every key it
 *                     defines; keys whose value is `undefined` are IGNORED
 *                     rather than applied, because `JSON.stringify` drops
 *                     `undefined` and an omitted key is exactly what blanks the
 *                     field upstream — letting an explicit `undefined` through
 *                     would reintroduce the bug one field at a time. To clear a
 *                     field deliberately, pass `null`.
 * @param allowedKeys  The keys the upstream `*In` schema accepts. Anything else
 *                     in the current row (`id`, `slug`, `created_at`, computed
 *                     `*Out`-only columns) is left out. Always
 *                     {@link bodyKeysOf} over the generated
 *                     `PUT_BODY_PROPERTIES`, never a hand-typed list.
 * @param neverPreserve Defaults to {@link NEVER_PRESERVE}. Widen it per call
 *                     site if an entity has another preserve-is-harm field;
 *                     narrowing it needs a reason written at the call site.
 *
 * @returns The merged body. Typed as `TBody` because it is a strict superset of
 *          `patch` — every added key is an `*In`-accepted key lifted off the
 *          current row — so it still satisfies whatever the generated `*In`
 *          interface requires.
 */
export async function mergeReplacingUpdate<TRow extends object, TBody extends object>(
  readCurrent: () => Promise<TRow>,
  patch: TBody,
  allowedKeys: Iterable<string>,
  neverPreserve: Iterable<string> = NEVER_PRESERVE,
): Promise<TBody> {
  const current = (await readCurrent()) as unknown as Record<string, unknown>;
  const blocked =
    neverPreserve instanceof Set ? neverPreserve : new Set<string>(neverPreserve);

  const merged: Record<string, unknown> = {};

  // Preserved half: only `*In` keys, only ones the row actually carries, never a
  // blocked key. `Object.hasOwn` and not a truthiness test — `0`, `''` and
  // `false` are legitimate stored values and dropping them would be the same
  // blanking bug with a different mask.
  const edited = (key: string): boolean =>
    Object.hasOwn(patch, key) && (patch as Record<string, unknown>)[key] !== undefined;
  const staleDependent = (key: string): boolean =>
    !edited(key) &&
    (DERIVED_ON_CHANGE[key] ?? []).some(
      (src) => edited(src) && (patch as Record<string, unknown>)[src] !== current[src],
    );
  for (const key of allowedKeys) {
    if (blocked.has(key)) continue;
    if (!Object.hasOwn(current, key)) continue;
    // A field RM derives from (or checks against) a source the edit changed.
    if (staleDependent(key)) continue;
    merged[key] = current[key];
  }

  // Caller half: wins, except for `undefined` (see `patch` above).
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }

  return merged as unknown as TBody;
}
