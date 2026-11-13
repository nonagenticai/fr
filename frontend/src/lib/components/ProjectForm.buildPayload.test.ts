// ProjectForm — CHARACTERISATION of buildPayload.
//
// ⛔ This test exists to be broken deliberately.
//
// The project request form collects ~50 fields. An exhaustive reader-grep of the
// backend found that 21 of them are WRITE-ONLY: zod accepts them, a rest
// destructure lands them in projects.project_data, and no code ever reads them
// back. They are being deleted.
//
// The hazard in that deletion is that a field which drops a LIVE value looks
// EXACTLY like a field which drops a dead one — same diff shape, same green
// suite, and the damage only surfaces later as an agent brief missing a
// constraint or a sign-off roster that silently fell back to the owner.
//
// So this pins the payload FIRST. Every key buildPayload emits today is asserted
// here. When a field is removed, this test fails, and the person removing it has
// to state in the diff which key they meant to drop. That is the entire value:
// it converts a silent omission into a required admission.
//
// ⚠️ Do NOT "fix" a failure here by deleting the assertion. Move the key into the
// `REMOVED` list below with the reason, so the record of what was dropped and why
// survives in the file rather than in a commit message nobody re-reads.

import { describe, expect, it } from 'vitest';
import {
	buildPayload,
	emptyBoundAssets,
	emptyFormState,
	SCOPE_FIELD_KEYS,
	type BuildPayloadContext,
	type ProjectFormState
} from './ProjectForm.svelte';

/**
 * Keys deliberately dropped from the payload, each with the reason it was safe.
 *
 * ⭐ THIS MAP IS THE POINT OF THE FILE. Every entry had to be added by hand
 * after this test went red, which is what forced someone to state — in a file
 * the next reader sees — WHY a field could go. A silent deletion cannot happen:
 * the key-set assertion fails until the key is listed here.
 *
 * "0 readers" below means an exhaustive grep of backend/src for the literal
 * key, `project_data.<key>`, and destructured use found no code that READS the
 * value. Landing in project_data is storage, not a reader.
 */
const REMOVED: Record<string, string> = {
  // ── George's point 1: priority has no effect on anything ────────────────
  priority: '0 readers. Every live `priority` belongs to the improvement-card schema or metering package ordering, neither fed from this field.',

  // ── George's point 3: people & roles ────────────────────────────────────
  sponsor: '0 readers.',
  delivery_owner: '0 readers.',
  operational_owner: '0 readers.',
  stakeholders: '0 readers. ⚠️ NOT to be confused with `approvers`, which is LIVE and is what seeds project_stakeholders.',
  requestor: 'Live only as a test-fixture allowlist marker (lib/execution-signoff.ts), never meaningful as user input. Defaults to the caller.',

  // ── George's point 4: classification / environment / access ─────────────
  data_classification: '0 readers. We work on repo FILES and cannot run the app, so the user cannot usefully answer this. The Zod key is GONE too as of 2026-09-23 — ProjectCreateSchema no longer accepts it.',
  target_environment: '0 readers. Same reason.',
  access_requirements: '0 readers. Replaced by actually verifying repo access rather than asking the user to describe it.',

  // ── George's point 5: deadline ──────────────────────────────────────────
  deadline: '0 readers. Every other `deadline` in the backend is approval expiry.',
  milestones: 'Not deleted — MOVED to Stage B (project_outlines), where the agent proposes them and the user approves. A user cannot author them before anyone has read the repo.',

  // ── George's point 6: resources & budget ────────────────────────────────
  effort_estimate: 'Moved to Stage B as the agent’s estimate.',
  resourcing: '0 readers.',
  budget: '0 readers. A real project budget needs per-project cost data that does not exist: billing_service has no project_id on any event or rollup table.',

  // ── found while measuring, same defect class, not in George's six ───────
  lifecycle_class: '0 backend readers.',
  // ⛔ in_scope / out_of_scope / high_level_requirements / assumptions are NO
  // LONGER REMOVED. They were listed here with "0 readers", annotated when
  // scopeFieldsForBrief (backend/src/routes/projects.ts) gave them a reader, and
  // RE-ADDED to the form 2026-09-23 on the owner's explicit decision. The
  // assertions that used to pin them as `undefined` are inverted below, in
  // 'buildPayload — the four project-definition scope fields'. Do not re-add
  // them here without first removing the form inputs: an entry in this map and a
  // live input in Section 4 is a contradiction the suite cannot detect for you.
  key_deliverables: '0 readers. Belongs to Stage B if anywhere.',
  notes: '0 readers.',
  env_placeholders: '0 readers.',
  secret_ids: '0 readers — an entire UI section whose output nothing consumed.',
  document_ids: '0 readers — likewise.',
  repository_id: '0 readers — likewise.',
};

function ctx(over: Partial<BuildPayloadContext> = {}): BuildPayloadContext {
	return { boundAssets: emptyBoundAssets(), ...over };
}

/** A form with EVERY field populated, so nothing is omitted merely for being empty. */
function fullForm(): ProjectFormState {
	return {
		...emptyFormState(),
		shape: 'deliverable',
		name: 'Payments hardening',
		description: 'desc',
		project_type: 'feature',
		scope_level: 'repo',
		approvers: ['ap-1'],
		problem_statement: 'problem',
		desired_outcome: 'outcome',
		business_case: 'case',
		success_criteria: ['sc-1'],
		acceptance_criteria: ['ac-1'],
		in_scope: ['is-1'],
		out_of_scope: ['oos-1'],
		high_level_requirements: ['hlr-1'],
		assumptions: ['as-1'],
		repositories: [
			{ url: 'https://github.com/acme/widget', branch: 'develop', name: '', is_primary: true }
		],
		constraints: [{ kind: 'no_language_version_change' }],
		dependencies: [{ name: 'payments-api', kind: 'service' }],
		risks: [{ description: 'vendor delay', likelihood: 'low', impact: 'high', mitigation: 'buffer' }]
	};
}

describe('buildPayload — the keys it emits today', () => {
	it('emits every populated field (the pin)', () => {
		const p = buildPayload(fullForm(), ctx());

		// --- identity / repo -------------------------------------------------
		expect(p.name).toBe('Payments hardening');
		expect(p.repository_url).toBe('https://github.com/acme/widget');
		expect(p.branch).toBe('develop');
		expect(p.shape).toBe('deliverable');
		expect(p.repo).toEqual({
			primary: { url: 'https://github.com/acme/widget', branch: 'develop' }
		});

		// --- classification --------------------------------------------------
		expect(p.description).toBe('desc');
		expect(p.project_type).toBe('feature');
		expect(p.scope_level).toBe('repo');

		// --- people ----------------------------------------------------------
		expect(p.approvers).toEqual(['ap-1']);

		// --- the brief -------------------------------------------------------
		expect(p.problem_statement).toBe('problem');
		expect(p.desired_outcome).toBe('outcome');
		expect(p.business_case).toBe('case');
		expect(p.success_criteria).toEqual(['sc-1']);
		expect(p.acceptance_criteria).toEqual(['ac-1']);
		expect(p.in_scope).toEqual(['is-1']);
		expect(p.out_of_scope).toEqual(['oos-1']);
		expect(p.high_level_requirements).toEqual(['hlr-1']);
		expect(p.assumptions).toEqual(['as-1']);

		// --- access / environment --------------------------------------------

		// --- timeline / resources --------------------------------------------
		expect(p.constraints).toEqual([{ kind: 'no_language_version_change' }]);
		expect(p.dependencies).toEqual([{ name: 'payments-api', kind: 'service' }]);
		expect(p.risks).toHaveLength(1);
	});

	it('the emitted key set is exactly what is recorded here', () => {
		// The single most valuable assertion in the file: an ADDED key that nobody
		// wired a reader for also fails this, not just a removed one.
		const expected = [
			'acceptance_criteria', 'access_requirements', 'approvers', 'assumptions',
			'branch', 'budget', 'business_case', 'constraints', 'data_classification',
			'deadline', 'delivery_owner', 'dependencies', 'description', 'desired_outcome',
			'effort_estimate', 'env_placeholders',
			'high_level_requirements', 'in_scope', 'key_deliverables', 'lifecycle_class',
			'milestones', 'name', 'notes', 'operational_owner', 'out_of_scope', 'priority',
			'problem_statement', 'project_type', 'repo', 'repository_url', 'requestor',
			'resourcing', 'risks', 'scope_level', 'shape', 'sponsor', 'stakeholders',
			'success_criteria', 'target_environment'
		].filter((k) => !(k in REMOVED));

		const actual = Object.entries(buildPayload(fullForm(), ctx()))
			.filter(([, v]) => v !== undefined)
			.map(([k]) => k)
			.sort();

		expect(actual).toEqual(expected.sort());
	});

	it('omits empty optionals rather than sending empty strings and arrays', () => {
		const p = buildPayload(emptyFormState(), ctx());
		for (const k of ['description', 'project_type', 'scope_level', 'risks', 'constraints']) {
			expect(p[k as keyof typeof p]).toBeUndefined();
		}
		// ...but the required identity field still goes, even empty.
		expect(p).toHaveProperty('name');
		// A repository is OPTIONAL (George 2026-10-13): no named row ⇒ neither
		// `repository_url` nor `repo` is sent (never '').
		expect(p).not.toHaveProperty('repository_url');
		expect(p).not.toHaveProperty('repo');
	});

	it('defaults the branch to main', () => {
		const p = buildPayload(
			{
				...fullForm(),
				repositories: [{ url: 'https://github.com/acme/widget', branch: '', name: '', is_primary: true }]
			},
			ctx()
		);
		expect(p.branch).toBe('main');
		expect(p.repo?.primary.branch).toBe('main');
	});
});

describe('buildPayload — the four project-definition scope fields', () => {
	// These four were in REMOVED above, asserted as `undefined`, because an
	// exhaustive backend grep found no reader. `scopeFieldsForBrief`
	// (backend/src/routes/projects.ts) is that reader now, and it spreads all
	// four into BOTH agent briefs — so the assertions here are the inverse of
	// what they were, deliberately.
	//
	// ⚠️ The reader's contract is ABSENCE, not emptiness: it omits a key with no
	// content because `"out_of_scope": []` claims "asked, and nothing is out of
	// scope", which is a different and false statement from "not answered". So
	// these tests assert the KEY IS NOT PRESENT — `toBeUndefined()` alone would
	// pass for a payload that carries `out_of_scope: undefined`, which JSON
	// happens to drop today and a future serialiser change need not.

	const present = (p: object) => SCOPE_FIELD_KEYS.filter((k) => k in p);

	it('emits all four with the entered items when all four are filled', () => {
		// KILLS: dropping any one of the four from the builder.
		const p = buildPayload(fullForm(), ctx());
		expect(present(p)).toEqual([...SCOPE_FIELD_KEYS]);
		expect(p.in_scope).toEqual(['is-1']);
		expect(p.out_of_scope).toEqual(['oos-1']);
		expect(p.high_level_requirements).toEqual(['hlr-1']);
		expect(p.assumptions).toEqual(['as-1']);
	});

	it('OMITS the key of an empty list — never [] and never a present undefined', () => {
		// KILLS: emitting the key unconditionally.
		const p = buildPayload({ ...fullForm(), out_of_scope: [] }, ctx());
		expect('out_of_scope' in p).toBe(false);
		// The other three are unaffected: an omission must be per-field, not a
		// whole-block gate that one empty list switches off.
		expect(present(p)).toEqual(['in_scope', 'high_level_requirements', 'assumptions']);

		// ...and an untouched form emits none of them at all.
		expect(present(buildPayload(emptyFormState(), ctx()))).toEqual([]);
	});

	it('OMITS a key whose entries are all blank, and trims the ones it keeps', () => {
		// KILLS: dropping the blank filter.
		const p = buildPayload(
			{ ...fullForm(), assumptions: ['   ', '', '\t'], in_scope: ['  padded  ', ' '] },
			ctx()
		);
		expect('assumptions' in p).toBe(false);
		expect(p.in_scope).toEqual(['padded']);
	});

	it('POSITIVE CONTROL: success_criteria behaves exactly as it did before', () => {
		// KILLS: any change to success_criteria's handling. Without this, the three
		// tests above could all pass against a form that had broken the field they
		// were copied from — which is how this lane shipped fields nothing read.
		// Note the ASYMMETRY is intentional and is what this control pins: the
		// pre-existing fields set the key to `undefined` when empty; the four new
		// ones omit it. Both serialise identically; only the reader's contract
		// distinguishes them, and only the four have that reader.
		expect(buildPayload(fullForm(), ctx()).success_criteria).toEqual(['sc-1']);

		const empty = buildPayload({ ...fullForm(), success_criteria: [] }, ctx());
		expect(empty.success_criteria).toBeUndefined();
		expect('success_criteria' in empty).toBe(true);

		// Blanks are NOT filtered for success_criteria — it never was, and
		// "improving" it here would be an unrequested behaviour change hiding
		// inside a scope-fields diff.
		expect(buildPayload({ ...fullForm(), success_criteria: ['  '] }, ctx()).success_criteria)
			.toEqual(['  ']);
	});
});

describe('buildPayload — the IT block is gated on project_type', () => {
	const itForm = (over: Partial<ProjectFormState> = {}): ProjectFormState => ({
		...fullForm(),
		project_type: 'it',
		it_flow: 'dependency',
		target_packages: [{ name: 'fastmcp', target_version: '2.3.0' }],
		test_command: 'pytest -q',
		target_files: ['src/a.py'],
		...over
	});

	it('sends the IT inputs for an it project', () => {
		const p = buildPayload(itForm(), ctx());
		expect(p.it_flow).toBe('dependency');
		// The shape the backend zod actually accepts. This sent ['fastmcp']
		// until 2026-09-21 and every such project 422'd.
		expect(p.target_packages).toEqual([{ name: 'fastmcp', target_version: '2.3.0' }]);
		expect(p.test_command).toEqual(['pytest', '-q']);
		expect(p.target_files).toEqual(['src/a.py']);
	});

	it('sends NONE of them for a non-it project — they would be dead keys in project_data', () => {
		const p = buildPayload(itForm({ project_type: 'feature' }), ctx());
		for (const k of ['it_flow', 'cve_sweep', 'bug_hunt', 'target_packages', 'test_command',
			'bug_test_command', 'bug_description', 'failing_test_ref', 'target_files',
			'min_severity']) {
			expect(p[k as keyof typeof p]).toBeUndefined();
		}
	});

	it('bug HUNT: sends bug_hunt + test_command, never bug_test_command / failing_test_ref / bug_description', () => {
		// The backend 400s a hunt carrying bug_test_command (bug_test_command_not_allowed_for_hunt),
		// so the hidden fields' stale values must not leak through.
		const p = buildPayload(
			itForm({
				it_flow: 'bug',
				bug_hunt: true,
				test_command: 'uv run --no-sync python -m pytest',
				bug_test_command: 'pytest -q t.py',
				failing_test_ref: 'test_x',
				bug_description: 'stale text'
			}),
			ctx()
		);
		expect(p.bug_hunt).toBe(true);
		expect(p.test_command).toEqual(['uv', 'run', '--no-sync', 'python', '-m', 'pytest']);
		expect('bug_test_command' in p && p.bug_test_command !== undefined).toBe(false);
		expect(p.failing_test_ref).toBeUndefined();
		expect(p.bug_description).toBeUndefined();

		// Control: the same form without the hunt flag is today's bug flow, unchanged.
		const plain = buildPayload(
			itForm({ it_flow: 'bug', bug_hunt: false, bug_test_command: 'pytest -q t.py' }),
			ctx()
		);
		expect(plain.bug_hunt).toBeUndefined();
		expect(plain.bug_test_command).toEqual(['pytest', '-q', 't.py']);
	});

	it('bug_hunt is ignored off the bug flow', () => {
		expect(buildPayload(itForm({ it_flow: 'security', bug_hunt: true }), ctx()).bug_hunt)
			.toBeUndefined();
	});

	it('sends bug_test_command and failing_test_ref only on the bug flow', () => {
		const bug = buildPayload(
			itForm({ it_flow: 'bug', bug_test_command: 'pytest -q t.py', failing_test_ref: 'test_x' }),
			ctx()
		);
		expect(bug.bug_test_command).toEqual(['pytest', '-q', 't.py']);
		expect(bug.failing_test_ref).toBe('test_x');

		const dep = buildPayload(
			itForm({ bug_test_command: 'pytest -q t.py', failing_test_ref: 'test_x' }),
			ctx()
		);
		expect(dep.bug_test_command).toBeUndefined();
		expect(dep.failing_test_ref).toBeUndefined();
	});

	it('sends min_severity only for the flows whose cards READ it', () => {
		// ⚠️ NARROWED 2026-10-01 from "the remediation flows" (REMEDIATION_FLOWS)
		// to SEVERITY_FLOWS. Measured in the live dispatch source
		// (n8n_custom_nodes/AA_IMPLEMENTATION/doing_action_procedures.json):
		// `min_severity` appears in `security_analysis`,
		// `development_security_patch` and `development_chore`, and ZERO times in
		// `bug_analysis`, `development_bug_fix` or `architecture_refactoring` —
		// the cards `bug` and `refactor` spawn. The control is hidden for those
		// two, so sending the value anyway would record a floor the user was never
		// asked for and nothing applies.
		// ⭐ WIDENED 2026-10-02 (fr#1335) to include `dependency`: `development_chore`
		// is the card that flow spawns and reads the key with `|| "LOW"`.
		for (const flow of ['dependency', 'security', 'source-security', 'iac']) {
			expect(
				buildPayload(itForm({ it_flow: flow, min_severity: 'high' }), ctx()).min_severity,
				`${flow} reads min_severity`
			).toBe('high');
		}
		// MUTATION: widen the gate back to REMEDIATION_FLOWS and these two fail.
		for (const flow of ['bug', 'refactor']) {
			expect(
				buildPayload(itForm({ it_flow: flow, min_severity: 'high' }), ctx()).min_severity,
				`${flow} does not read min_severity`
			).toBeUndefined();
		}
	});

	// ───────────────────────────────────────────────────────────────────────────
	// fr#1335 — the CVE sweep severity floor.
	//
	// `dependency` was excluded from SEVERITY_FLOWS until 2026-10-02, so the form
	// never sent `min_severity` for it. `development_chore` — the card the
	// dependency flow spawns, and the one a `cve_sweep` discovery run drives —
	// reads `dispatch_context.min_severity || "LOW"`
	// (backend/src/scripts/seed-it-procedures.ts:448), so EVERY sweep ever run
	// executed at the LOW floor regardless of what the operator intended, and no
	// control existed that could raise it.
	//
	// MUTATION: drop `min_severity` from the IT block in buildPayload, or remove
	// `'dependency'` from SEVERITY_FLOWS, and all three legs below fail.
	it('sends the chosen min_severity on the dependency flow — the CVE sweep floor', () => {
		// Discovery mode: this is the run whose breadth the floor decides.
		expect(
			buildPayload(
				itForm({ it_flow: 'dependency', cve_sweep: true, target_packages: [], min_severity: 'CRITICAL' }),
				ctx()
			).min_severity,
			'cve_sweep discovery run carries the operator floor'
		).toBe('CRITICAL');

		// Targeted mode: same card, same reader, so the floor travels too.
		expect(
			buildPayload(itForm({ it_flow: 'dependency', min_severity: 'MODERATE' }), ctx()).min_severity,
			'targeted dependency upgrade carries the operator floor'
		).toBe('MODERATE');

		// The form's own default must arrive as itself, not as the procedure's
		// `"LOW"` fallback — a defaulted floor that silently differs from the one
		// shown in the control is the defect this test exists for.
		expect(
			buildPayload({ ...itForm(), min_severity: emptyFormState().min_severity }, ctx()).min_severity,
			"the form's default floor is sent, not left to the procedure fallback"
		).toBe('HIGH');
	});

	it('sends bug_description only on the bug flow, and omits it blank', () => {
		// SHAPE-B: `bug_analysis` and `development_bug_fix` both read
		// `dispatch_context.bug_description` and ProjectCreateSchema has declared
		// the key all along, but no control collected it — so every bug project
		// dispatched with the bug report EMPTY. MUTATION: drop the key from the IT
		// block and the first assertion fails.
		const bug = buildPayload(
			itForm({ it_flow: 'bug', bug_description: 'PDF over 10 MB returns 500' }),
			ctx()
		);
		expect(bug.bug_description).toBe('PDF over 10 MB returns 500');

		// Omit, never ''. An empty string claims "the bug has no description".
		expect(
			buildPayload(itForm({ it_flow: 'bug', bug_description: '   ' }), ctx()).bug_description
		).toBeUndefined();

		// Not asked on any other flow — security sources its description from the
		// scan finding (`finding_description`), not from the requester.
		expect(
			buildPayload(itForm({ it_flow: 'security', bug_description: 'x' }), ctx()).bug_description
		).toBeUndefined();
		expect(
			buildPayload(itForm({ bug_description: 'x' }), ctx()).bug_description
		).toBeUndefined();
	});
});

describe('buildPayload — bound assets are the only context left', () => {
	// secret_ids / document_ids / repository_id were three whole UI sections
	// whose output landed in project_data and was read by nothing. They are
	// gone, and with them the context fields that carried them — which is why
	// BuildPayloadContext is now a single field.
	it('emits bound_assets only for non-empty kinds', () => {
		const assets = { ...emptyBoundAssets(), document: ['doc-1'] };
		const p = buildPayload(fullForm(), ctx({ boundAssets: assets }));
		expect(p.bound_assets).toEqual({ document: ['doc-1'] });
		expect(buildPayload(fullForm(), ctx()).bound_assets).toBeUndefined();
	});

	it('the three deleted pickers emit nothing', () => {
		const p = buildPayload(fullForm(), ctx()) as unknown as Record<string, unknown>;
		expect(p.secret_ids).toBeUndefined();
		expect(p.document_ids).toBeUndefined();
		expect(p.repository_id).toBeUndefined();
	});
});

describe('buildPayload — N repositories (the reported multi_repo defect)', () => {
	const rows = (...r: { url: string; branch?: string; name?: string; is_primary?: boolean }[]) =>
		r.map((x) => ({ url: x.url, branch: x.branch ?? '', name: x.name ?? '', is_primary: !!x.is_primary }));

	it('the primary row becomes repository_url; the rest become repo.additional', () => {
		const p = buildPayload(
			{
				...fullForm(),
				scope_level: 'multi_repo',
				repositories: rows(
					{ url: 'https://github.com/acme/b', branch: 'dev', name: 'b' },
					{ url: 'https://github.com/acme/a', branch: 'main', is_primary: true }
				)
			},
			ctx()
		);
		expect(p.repository_url).toBe('https://github.com/acme/a');
		expect(p.branch).toBe('main');
		expect(p.repo?.additional).toEqual([{ url: 'https://github.com/acme/b', branch: 'dev', name: 'b' }]);
	});

	it('blank branch/name on an additional repo are OMITTED, not sent as empty strings', () => {
		// The backend declares them z.string().min(1).optional(): '' would 422.
		const p = buildPayload(
			{
				...fullForm(),
				scope_level: 'multi_repo',
				repositories: rows(
					{ url: 'https://github.com/acme/a', is_primary: true },
					{ url: 'https://github.com/acme/b' }
				)
			},
			ctx()
		);
		expect(p.repo?.additional).toEqual([{ url: 'https://github.com/acme/b' }]);
	});

	it('blank rows are ignored and a single repo sends no additional key', () => {
		const p = buildPayload(
			{
				...fullForm(),
				repositories: rows({ url: 'https://github.com/acme/a', is_primary: true }, { url: '  ' })
			},
			ctx()
		);
		expect(p.repo).toEqual({ primary: { url: 'https://github.com/acme/a', branch: 'main' } });
	});
});
