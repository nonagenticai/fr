# Provenance: derived-coverage-card-approval-no-pr.json

- **Source:** `nonagenticai/n8n_custom_nodes@7b01376495bc7d073c9f0964d9ed0dccb56d2eef:workflows/patterns/blocked-escalate.json`
  (ncn#1969), nodes `Merge Procedure Hint` -> `Build Proposition` -> `Call FR` (`jsonBody` expression).
- **How:** PRODUCED, not hand-written. The generator below executes those three nodes' code from that sha
  with the §2e inputs of `scripts/tests/test-blocked-escalate-r5-prefix-map.mjs` (card `c-9`,
  `development_bug_fix`, block_reason `no_computed_check:development_bug_fix:crit_a1,crit_b2`) and
  NO `pr_url` in the card's runtime state, then serialises the evaluated Call FR body verbatim.
  It asserts `coverage_request.source === 'derived'` and `pr_url === null`.
- **Command:** `node ~/.claude/plans/r5-fixtures/gen-no-pr-body.mjs <ncn-checkout-at-7b013764> <out.json>`
  (`<ncn-checkout>` only needs `workflows/patterns/blocked-escalate.json` from that sha:
  `git show 7b01376495bc7d073c9f0964d9ed0dccb56d2eef:workflows/patterns/blocked-escalate.json`).
- **Vendored byte-identical** (no wrapper, unlike the with-PR sibling, so the bytes match the source):
  sha256 `ded008ee209391ce7a24e99c8eaff1da61361ddb3ed76c9239e2490b3b16235b` — source file, this copy,
  and an independent re-run of the generator on 2026-10-02 all match.
- `tenant_id: 't-1'` / `card_id: 'c-9'` are harness placeholders; a test may overlay ONLY routing
  fields (tenant_id, approver_user_id, card_name, boardId) — never anything under `metadata`.

## Generator (verbatim copy of `gen-no-pr-body.mjs`)

```js
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = process.argv[2], OUT = process.argv[3];
const wf = JSON.parse(readFileSync(ROOT + '/workflows/patterns/blocked-escalate.json', 'utf8'));
const code = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;
const BP = code('Build Proposition'), MPH = code('Merge Procedure Hint');
const mk = (json) => ({ json, item: { json }, first: () => ({ json }), all: () => [{ json }] });
const CODING = 'development_bug_fix';
const mergeHint = (notif, agg) => { const refs = { 'Build Notification': notif, 'Aggregate Activity Outputs': agg };
  const $ = (r) => { const v = refs[r] || {}; return { first: () => ({ json: v }), all: () => [{ json: v }] }; };
  return new Function('$', '$input', MPH)($, { first: () => ({ json: {} }) })[0].json; };
const propose = (m) => new Function('$', '$input', '$json', BP)((n) => mk(m), mk(m), m)[0].json;
const callFrBody = (p) => { const expr = String(wf.nodes.find((x) => x.name === 'Call FR').parameters.jsonBody).replace(/^=\{\{\s*/, '').replace(/\s*\}\}\s*$/, '');
  const refs = { 'Merge Procedure Hint': { tenant_id: 't-1' }, 'Build Notification': { card_type: p.card_type } };
  return JSON.parse(new Function('$json', '$', 'return ' + expr)(p, (r) => ({ first: () => ({ json: refs[r] || {} }) }))); };
const notif = { card_id: 'c-9', card_type: CODING, reason: 'No reason provided', project_id: null };
const AC = [{ criterion_id: 'crit_a1', text: 'login rejects a bad password' }, 'crit_b2: audit row is written', { id: 'crit_c3', text: 'lockout after 5 tries' }];
const GHK = [{ criterion_id: 'crit_a1', scenario_id: 'sc_1', gherkin: 'Given a user\nWhen a bad password\nThen 401' }];
const agg = { prior_outputs: { 'card-hydration': { hydrated: true, acceptance_criteria: AC, development_chore_inputs: { gherkin_scenarios: GHK },
  fields: { runtime: { block_reason: `no_computed_check:${CODING}:crit_a1,crit_b2` } } } } };   // NO pr_url
const m = mergeHint(notif, agg); const p = propose(m); const body = callFrBody(p);
const cr = body.metadata && body.metadata.coverage_request;
if (!cr || cr.source !== 'derived' || cr.pr_url !== null) { console.error('UNEXPECTED', JSON.stringify(cr)); process.exit(1); }
writeFileSync(OUT, JSON.stringify(body, null, 2) + '\n');
console.log('ok deblock_action=' + body.deblock_action, 'pr_url=' + cr.pr_url, 'criteria=' + cr.criteria.map((c) => c.criterion_id));
```
