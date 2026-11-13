/**
 * fr-agui SPEC §5.2 / §6.2 — pure helpers for the agent's confirm cards.
 *
 * A card turns an AgentProposal (a write the agent proposed and did not run)
 * into the request the classic UI would make, sent under the HUMAN's session.
 */
import type { ProjectFormState } from '$lib/components/ProjectForm.svelte';
import { isApprovalMode } from '$lib/types/api';

/** The ProjectForm `initial` for a `projects.create` proposal. Never carries a secret. */
export function proposalToFormInitial(input: Record<string, unknown>): Partial<ProjectFormState> {
	const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
	const out: Partial<ProjectFormState> = {};
	const name = str(input.title) ?? str(input.name);
	if (name) out.name = name;
	const type = str(input.project_type);
	if (type) out.project_type = type;
	const description = str(input.description);
	if (description) out.description = description;
	const problem = str(input.problem_statement);
	if (problem) out.problem_statement = problem;
	const outcome = str(input.desired_outcome);
	if (outcome) out.desired_outcome = outcome;
	const repo = str(input.repository_url);
	if (repo) {
		out.repositories = [{ url: repo, branch: '', name: '', is_primary: true }];
	}
	// Absent or unknown ⇒ the form default (brief_and_closure).
	if (isApprovalMode(input.approval_mode)) out.approval_mode = input.approval_mode;
	return out;
}

interface ErrorLike {
	status?: number;
	message?: string;
	data?: unknown;
}

/**
 * The server's refusal, VERBATIM (SPEC §5.6): its code, its message and, for a
 * type refusal, the allowed list. 503 `conveyor_not_configured`, 409, 422 and
 * 403 all render as `<code>: <message>`; nothing is reworded or swallowed.
 */
export function verbatimErrorText(err: unknown): string {
	const e = (err ?? {}) as ErrorLike;
	const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
	const code =
		(typeof data.error === 'string' && data.error) ||
		(typeof data.code === 'string' && data.code) ||
		(typeof e.status === 'number' && e.status > 0 ? `http_${e.status}` : '');
	const message =
		(typeof data.message === 'string' && data.message) ||
		(typeof data.detail === 'string' && data.detail) ||
		(typeof e.message === 'string' ? e.message : '');
	const allowed = Array.isArray(data.allowed) ? ` (allowed: ${data.allowed.join(', ')})` : '';
	const parts = [code, message && message !== code ? message : ''].filter(Boolean);
	return `${parts.join(': ')}${allowed}` || 'The request failed';
}

/** SPEC §5.2 DecideInput (the agent's proposal for approvals.decide). */
export interface DecideInput {
	approvalId: string;
	decision: 'approve' | 'reject';
	comment?: string;
	reason?: string;
	deblock_action?: string;
	new_card_type?: string;
	rejected_criterion_ids?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isFullApprovalId(id: unknown): id is string {
	return typeof id === 'string' && UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// fr-agui SPEC §6.0 / §13 P1b — the `project-request` confirm card.
// ---------------------------------------------------------------------------

/** The request-lifecycle writes the doorway agent proposes (never `project_requests.create`: the bridge). */
export type ProjectRequestAction =
	| 'project_requests.draft_from_text'
	| 'project_requests.patch'
	| 'project_requests.submit'
	| 'project_requests.approve'
	| 'project_requests.reject'
	| 'project_requests.withdraw';

export const PROJECT_REQUEST_ACTIONS: ReadonlyArray<ProjectRequestAction> = [
	'project_requests.draft_from_text',
	'project_requests.patch',
	'project_requests.submit',
	'project_requests.approve',
	'project_requests.reject',
	'project_requests.withdraw'
];

export function isProjectRequestAction(a: string): a is ProjectRequestAction {
	return (PROJECT_REQUEST_ACTIONS as ReadonlyArray<string>).includes(a);
}

/** The editable fields a card shows for each action, in order. `id` is the path, never a field. */
export const PROJECT_REQUEST_FIELDS: Readonly<Record<ProjectRequestAction, ReadonlyArray<string>>> = {
	'project_requests.draft_from_text': ['name', 'text'],
	'project_requests.patch': [
		'name',
		'description',
		'project_type',
		'problem_statement',
		'desired_outcome',
		'business_case',
		'repository_url'
	],
	'project_requests.submit': [],
	'project_requests.approve': [],
	'project_requests.reject': ['reason'],
	'project_requests.withdraw': []
};

/** Fields that must be non-empty before Confirm is enabled. */
export const PROJECT_REQUEST_REQUIRED: Readonly<Partial<Record<ProjectRequestAction, ReadonlyArray<string>>>> = {
	'project_requests.draft_from_text': ['text'],
	'project_requests.reject': ['reason']
};

export const PROJECT_REQUEST_CONFIRM_LABEL: Readonly<Record<ProjectRequestAction, string>> = {
	'project_requests.draft_from_text': 'Confirm and draft the request',
	'project_requests.patch': 'Confirm the edit',
	'project_requests.submit': 'Confirm and submit',
	'project_requests.approve': 'Confirm and approve',
	'project_requests.reject': 'Confirm rejection',
	'project_requests.withdraw': 'Confirm withdrawal'
};

/** The string fields a card starts with: the proposal's own values, empty for the rest. */
export function requestCardInitialValues(
	action: ProjectRequestAction,
	input: Record<string, unknown>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of PROJECT_REQUEST_FIELDS[action]) out[f] = typeof input[f] === 'string' ? (input[f] as string) : '';
	return out;
}

/**
 * The request body a confirmed card sends: the edited string fields, blanks
 * dropped (an omitted field leaves the stored value untouched on PATCH).
 */
export function requestCardBody(action: ProjectRequestAction, values: Record<string, string>): Record<string, string> {
	const body: Record<string, string> = {};
	for (const f of PROJECT_REQUEST_FIELDS[action]) {
		const v = (values[f] ?? '').trim();
		if (v) body[f] = v;
	}
	return body;
}

export function requestCardCanConfirm(action: ProjectRequestAction, values: Record<string, string>): boolean {
	return (PROJECT_REQUEST_REQUIRED[action] ?? []).every((f) => (values[f] ?? '').trim() !== '');
}

/**
 * Where the card leads once the route answered: an approve leads INTO the new
 * project's shell ("Open project", SPEC §6.0); everything else to the request's
 * review page. `null` when the response names neither.
 */
export function requestCardResultLink(
	action: ProjectRequestAction,
	requestId: string | null,
	result: unknown
): { href: string; label: string; testid: string } | null {
	const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
	if (action === 'project_requests.approve') {
		const project = r.project && typeof r.project === 'object' ? (r.project as Record<string, unknown>) : null;
		const pid = project && typeof project.id === 'string' ? project.id : null;
		return pid ? { href: `/projects/${pid}`, label: 'Open project →', testid: 'project-request-card-open-project' } : null;
	}
	const rid =
		action === 'project_requests.draft_from_text'
			? typeof r.project_request_id === 'string'
				? r.project_request_id
				: null
			: requestId;
	return rid ? { href: `/projects/requests/${rid}`, label: 'Open request →', testid: 'project-request-card-open-request' } : null;
}

// ---------------------------------------------------------------------------
// fr-agui SPEC §5.2 (W) / §13 P1c-b — the `capability-invoke` confirm card: an
// AGENT-NATIVE write (no UI route of its own; today the project TOC builds)
// confirmed through `POST /api/capabilities/:id/invoke` under the human's session.
// ---------------------------------------------------------------------------

/** Keys the card never shows as editable: the binding and the request's own idempotency. */
const INVOKE_FIXED_KEYS: ReadonlySet<string> = new Set(['project_id', 'projectId', 'visible_in', 'idempotency_key']);

export type InvokeFieldKind = 'text' | 'multiline' | 'number' | 'boolean' | 'json';
export interface InvokeField {
	key: string;
	kind: InvokeFieldKind;
	/** The editable text (JSON text for `json`, 'true'/'false' for `boolean`). */
	value: string;
	/** The text as first shown. An UNCHANGED field is sent as the proposal's own value. */
	initial: string;
}

/**
 * The ONE route this card may call: `POST /api/capabilities/<its action>/invoke`.
 * A proposal naming any other method or path is not rendered as invokable —
 * the card never calls a route the proposal merely asserts.
 */
export function isInvokeProposal(p: { card?: unknown; action?: unknown; http?: { method?: unknown; path?: unknown } }): boolean {
	return p.card === 'capability-invoke' && invokesOwnRoute(p);
}

/**
 * fr-agui P2-c2: the route check alone — shared by every card that confirms through
 * the invoke route (`capability-invoke`, `artifact-review`, `typed-confirm`).
 */
export function invokesOwnRoute(p: { action?: unknown; http?: { method?: unknown; path?: unknown } }): boolean {
	return (
		typeof p.action === 'string' &&
		/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(p.action) &&
		p.http?.method === 'POST' &&
		p.http?.path === `/api/capabilities/${p.action}/invoke`
	);
}

/** The editable fields of an invoke proposal, in input order (the binding and secrets excluded). */
export function invokeCardFields(
	input: Record<string, unknown>,
	secretFields: readonly string[],
	action = 'toc.'
): InvokeField[] {
	const out: InvokeField[] = [];
	const secret = new Set(secretFields);
	for (const [key, v] of Object.entries(input)) {
		if (INVOKE_FIXED_KEYS.has(key) || secret.has(key)) continue;
		const push = (kind: InvokeFieldKind, value: string) => out.push({ key, kind, value, initial: value });
		if (typeof v === 'string') push(v.length > 80 || v.includes('\n') ? 'multiline' : 'text', v);
		else if (typeof v === 'number') push('number', String(v));
		else if (typeof v === 'boolean') push('boolean', String(v));
		else push('json', v === undefined ? '' : JSON.stringify(v, null, 2));
	}
	// `payload` is optional on the TOC builds: offer it even when the agent left it out
	// (only there — no other invoke action takes a payload, e.g. projects.provision).
	if (action.startsWith('toc.') && !('payload' in input) && !secret.has('payload')) {
		out.push({ key: 'payload', kind: 'json', value: '', initial: '' });
	}
	return out;
}

/**
 * The `idempotency_key` a confirmed card sends: the proposal's own, or — when the
 * agent left it out — one derived from the proposal id. Either way it is STABLE
 * per proposal (the same across a re-render or a remount of the card).
 *
 * ⭐ THIS is what makes a double confirm run once. The toc confirm spec carries
 * no `idempotent` flag, so the proposal has no `idempotencyKey` and no
 * `Idempotency-Key` header is sent; the invoke route reads `X-Agent-Proposal-Id`
 * for AUDIT only (services/capability-audit.ts) — it binds nothing. Dedupe is:
 * the card's `submitting` state (a double click in one render), and the
 * registry's per-user `runIdempotent` (24h) on the action's key, which the toc
 * builds derive from this input `idempotency_key` + `project_id`
 * (agui/actions/toc.ts) — so a second confirm of the same proposal returns the
 * first run's result instead of running again.
 */
export function invokeIdempotencyKey(input: Record<string, unknown>, proposalId: string): string {
	const own = input.idempotency_key;
	return typeof own === 'string' && own.trim() !== '' ? own : `agui-proposal:${proposalId}`;
}

/**
 * The request body a confirmed card sends: the proposal's input with the edited
 * fields applied. The binding (`project_id`) and `idempotency_key` are the
 * proposal's own and cannot be edited here; the key is always present and stable
 * per proposal (`invokeIdempotencyKey`). Throws on a JSON field that does not
 * parse (the card shows it; nothing is sent).
 */
export function invokeCardBody(
	input: Record<string, unknown>,
	fields: readonly InvokeField[],
	proposalId: string
): Record<string, unknown> {
	const body: Record<string, unknown> = { ...input, idempotency_key: invokeIdempotencyKey(input, proposalId) };
	for (const f of fields) {
		// The display may be redacted (agent-redact.ts); an untouched field keeps
		// the proposal's own value rather than sending the masked text back.
		if (INVOKE_FIXED_KEYS.has(f.key) || f.value === f.initial) continue;
		if (f.kind === 'json') {
			const t = f.value.trim();
			if (t === '') {
				delete body[f.key];
				continue;
			}
			try {
				body[f.key] = JSON.parse(t);
			} catch {
				throw new Error(`${f.key}: not valid JSON`);
			}
		} else if (f.kind === 'number') {
			const n = Number(f.value);
			if (!Number.isFinite(n)) throw new Error(`${f.key}: not a number`);
			body[f.key] = n;
		} else if (f.kind === 'boolean') {
			body[f.key] = f.value === 'true';
		} else {
			body[f.key] = f.value;
		}
	}
	return body;
}

/** What the invoke route answered: a parked approval to review, or the result. */
export function invokeOutcome(data: unknown): { kind: 'parked'; approvalId: string } | { kind: 'done' } {
	const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
	if (d.status === 'pending' && typeof d.approvalId === 'string') return { kind: 'parked', approvalId: d.approvalId };
	return { kind: 'done' };
}

/** "toc.build_io_map" → "Build io map (toc)". */
export function actionTitle(action: string): string {
	const [ns, verb] = action.split('.');
	const words = (verb ?? action).replace(/_/g, ' ');
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}${ns && verb ? ` (${ns})` : ''}`;
}

// ---------------------------------------------------------------------------
// fr-agui SPEC §5.5 / §13 P2-b — the FileCard (`file-upload`): the agent proposed
// `documents.upload`; the human picks the file and it goes from the BROWSER to
// the project's own upload route (`POST /api/documents/upload`, multipart, the
// bound `project_id`), where kag/ClamAV scan it fail-closed. The bytes never pass
// through the agent; the card shows only {fileName, size, mime, documentId}.
// ---------------------------------------------------------------------------

/** The ONE route a FileCard may call. */
export const FILE_UPLOAD_ROUTE = '/api/documents/upload';

/**
 * Confirmable only when the proposal names exactly the documents upload action,
 * its route and a bound project — the card never posts a file to a route the
 * proposal merely asserts.
 */
export function isFileUploadProposal(p: {
	card?: unknown;
	action?: unknown;
	http?: { method?: unknown; path?: unknown };
	input?: Record<string, unknown>;
}): boolean {
	return (
		p.card === 'file-upload' &&
		p.action === 'documents.upload' &&
		p.http?.method === 'POST' &&
		p.http?.path === FILE_UPLOAD_ROUTE &&
		typeof p.input?.project_id === 'string' &&
		p.input.project_id.length > 0
	);
}

/** What the card (and so the agent's view) learns about an uploaded file. */
export interface UploadedFileSummary {
	documentId: string;
	fileName: string;
	size: number;
	mime: string;
	status: string;
}

/** Read the upload route's answer (`{id, filename, file_size, file_type, status}`), never its bytes. */
export function uploadedFileSummary(res: unknown, file: { name: string; size: number; type: string }): UploadedFileSummary {
	const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
	const doc = (r.document && typeof r.document === 'object' ? r.document : r) as Record<string, unknown>;
	const str = (v: unknown, d: string) => (typeof v === 'string' && v !== '' ? v : d);
	return {
		documentId: str(doc.id, ''),
		fileName: str(doc.filename, file.name),
		size: typeof doc.file_size === 'number' ? doc.file_size : file.size,
		mime: str(doc.file_type ?? doc.mime_type, file.type || 'application/octet-stream'),
		status: str(doc.status, 'pending')
	};
}

// ---------------------------------------------------------------------------
// fr-agui P2-c2 — the `artifact-review` card (the HUMAN decides) and the
// `typed-confirm` card (a destructive write the human confirms by typing a name).
// Both confirm through `POST /api/capabilities/<action>/invoke` under the human's
// session, like the capability-invoke card (`isInvokeProposal` is their gate too).
// ---------------------------------------------------------------------------

export type ReviewDecision = 'approve' | 'reject' | 'revise';
export const REVIEW_DECISIONS: ReadonlyArray<{ value: ReviewDecision; label: string }> = [
	{ value: 'approve', label: 'Approve' },
	{ value: 'reject', label: 'Reject' },
	{ value: 'revise', label: 'Request a revision' }
];

/**
 * The review body the card sends: the proposal's binding (project + artifact) and
 * ONLY the human's own choice and words. Whatever the proposal carried for
 * `decision` / `comment` is ignored (the server strips them too): the agent never
 * decides. `null` decision ⇒ nothing may be sent.
 */
export function reviewCardBody(
	input: Record<string, unknown>,
	decision: ReviewDecision | null,
	comment: string,
	proposalId: string
): Record<string, unknown> | null {
	if (decision === null) return null;
	const body: Record<string, unknown> = {
		project_id: input.project_id,
		artifact_id: input.artifact_id,
		decision,
		idempotency_key: invokeIdempotencyKey(input, proposalId)
	};
	const c = comment.trim();
	if (c !== '') body.comment = c;
	return body;
}

/** A typed confirmation matches only the exact name (surrounding spaces ignored, case kept). */
export function typedConfirmMatches(typed: string, expected: string | null | undefined): boolean {
	const want = (expected ?? '').trim();
	return want !== '' && typed.trim() === want;
}

/** The typed-confirm body: the binding, the human-typed name, the stable idempotency key. */
export function typedConfirmBody(input: Record<string, unknown>, typed: string, proposalId: string): Record<string, unknown> {
	return { project_id: input.project_id, confirm_name: typed.trim(), idempotency_key: invokeIdempotencyKey(input, proposalId) };
}

/** What the typed card asks the human to type, per action, and what the name is (a project's, or a model's title). */
export const TYPED_CONFIRM_COPY: Readonly<
	Record<string, { title: string; effect: string; confirm: string; done: string; subject: 'project' | 'model' | 'uml' | 'archimate' }>
> = {
	'projects.archive': {
		title: 'Archive this project',
		effect:
			"Archiving purges the project's documents from the knowledge graph, tears its board down and removes it from the project lists. It cannot be undone here.",
		confirm: 'Archive the project',
		done: 'is archived',
		subject: 'project'
	},
	'architecture.delete_model': {
		title: 'Delete an architecture model',
		effect:
			'Deleting removes the model for everyone. If it has saved versions, they are deleted too, with its rule checks and imported changes. It cannot be undone.',
		confirm: 'Delete the model',
		done: 'is deleted',
		subject: 'model'
	},
	'architecture.delete_element': {
		title: 'Delete an ArchiMate element',
		effect: 'Its relationships and the shapes showing it on every view are deleted with it. It cannot be undone.',
		confirm: 'Delete the element',
		done: 'is deleted',
		subject: 'archimate'
	},
	'architecture.delete_relationship': {
		title: 'Delete an ArchiMate relationship',
		effect: 'The lines showing it on every view are deleted with it. It cannot be undone.',
		confirm: 'Delete the relationship',
		done: 'is deleted',
		subject: 'archimate'
	},
	'architecture.delete_view': {
		title: 'Delete an ArchiMate view',
		effect: 'Only the view goes; the elements and relationships it showed stay in the model. It cannot be undone.',
		confirm: 'Delete the view',
		done: 'is deleted',
		subject: 'archimate'
	},
	'architecture.delete_uml_element': {
		title: 'Delete a UML element',
		effect: 'What it owns, the relationships attached to it and the diagram shapes showing it are deleted with it. It cannot be undone.',
		confirm: 'Delete the element',
		done: 'is deleted',
		subject: 'uml'
	},
	'architecture.delete_uml_relationship': {
		title: 'Delete a UML relationship',
		effect: 'The diagram lines showing it are deleted with it. It cannot be undone.',
		confirm: 'Delete the relationship',
		done: 'is deleted',
		subject: 'uml'
	},
	'architecture.delete_uml_interaction': {
		title: 'Delete a UML interaction',
		effect: 'Its participants and messages, and the diagram shapes showing them, are deleted with it. It cannot be undone.',
		confirm: 'Delete the interaction',
		done: 'is deleted',
		subject: 'uml'
	},
	'architecture.delete_uml_diagram': {
		title: 'Delete a UML diagram',
		effect: 'Only the diagram goes; the elements and relationships it showed stay in the model. It cannot be undone.',
		confirm: 'Delete the diagram',
		done: 'is deleted',
		subject: 'uml'
	}
};

/** Which UML collection and input key a typed UML delete names. */
export const UML_DELETE_TARGET: Readonly<Record<string, { resource: 'elements' | 'relationships' | 'interactions' | 'diagrams'; field: string }>> = {
	'architecture.delete_uml_element': { resource: 'elements', field: 'element_id' },
	'architecture.delete_uml_relationship': { resource: 'relationships', field: 'relationship_id' },
	'architecture.delete_uml_interaction': { resource: 'interactions', field: 'interaction_id' },
	'architecture.delete_uml_diagram': { resource: 'diagrams', field: 'diagram_id' }
};

/** Which ArchiMate collection and input key a typed ArchiMate delete names. */
export const ARCHIMATE_DELETE_TARGET: Readonly<Record<string, { resource: 'elements' | 'relationships' | 'views'; field: string }>> = {
	'architecture.delete_element': { resource: 'elements', field: 'element_id' },
	'architecture.delete_relationship': { resource: 'relationships', field: 'relationship_id' },
	'architecture.delete_view': { resource: 'views', field: 'view_id' }
};

/** The name an ArchiMate delete card asks for: an element's or view's title, a relationship's type — as the server re-checks it. */
export function archimateConfirmName(row: { title?: unknown; relationship_type?: unknown } | null | undefined): string | null {
	const t = typeof row?.title === 'string' ? row.title.trim() : '';
	const r = typeof row?.relationship_type === 'string' ? row.relationship_type.trim() : '';
	return t || r || null;
}

/** The name a UML delete card asks for: the row's name, or (an unnamed row) its kind — as the server re-checks it. */
export function umlConfirmName(row: { name?: unknown; kind?: unknown } | null | undefined): string | null {
	const n = typeof row?.name === 'string' ? row.name.trim() : '';
	const k = typeof row?.kind === 'string' ? row.kind.trim() : '';
	return n || k || null;
}

/**
 * The typed-confirm body for `action`: the proposal's binding and target, the
 * human-typed name in the field that action's server re-checks, and the stable
 * idempotency key.
 */
export function typedConfirmBodyFor(
	action: string,
	input: Record<string, unknown>,
	typed: string,
	proposalId: string
): Record<string, unknown> {
	const uml = UML_DELETE_TARGET[action] ?? ARCHIMATE_DELETE_TARGET[action];
	if (uml) {
		return {
			project_id: input.project_id,
			[uml.field]: input[uml.field],
			confirm_name: typed.trim(),
			idempotency_key: invokeIdempotencyKey(input, proposalId)
		};
	}
	if (TYPED_CONFIRM_COPY[action]?.subject === 'model') {
		const body: Record<string, unknown> = {
			project_id: input.project_id,
			model_id: input.model_id,
			confirm_title: typed.trim(),
			idempotency_key: invokeIdempotencyKey(input, proposalId)
		};
		if (input.force === true) body.force = true;
		return body;
	}
	return typedConfirmBody(input, typed, proposalId);
}

// ---------------------------------------------------------------------------
// The ArchiMate modeling cards: a REVIEW the human decides (`model-review`) and
// an exchange-file IMPORT the human picks (`model-import`). The agent proposes;
// it never decides a review and never sees the file.
// ---------------------------------------------------------------------------

export const MODEL_REVIEW_DECISIONS = ['approve', 'reject'] as const;
export type ModelReviewDecision = (typeof MODEL_REVIEW_DECISIONS)[number];

/**
 * The confirmed review body, or null when the human has not chosen. A rejection
 * needs a reason (null until one is written) — the same rule the server applies.
 */
export function modelReviewBody(
	input: Record<string, unknown>,
	decision: ModelReviewDecision | null,
	reason: string,
	proposalId: string
): Record<string, unknown> | null {
	if (decision === null) return null;
	const r = reason.trim();
	if (decision === 'reject' && r === '') return null;
	const body: Record<string, unknown> = {
		project_id: input.project_id,
		model_id: input.model_id,
		revision_id: input.revision_id,
		decision,
		idempotency_key: invokeIdempotencyKey(input, proposalId)
	};
	if (r !== '') body.reason = r;
	return body;
}

/** The ONE route a model-import card may post a file to. */
export const MODEL_IMPORT_ROUTE = '/api/assets/architecture/modeling/imports';

/** Confirmable only when the proposal names exactly the import action, its route and a bound project. */
export function isModelImportProposal(p: {
	card?: unknown;
	action?: unknown;
	http?: { method?: unknown; path?: unknown };
	input?: Record<string, unknown>;
}): boolean {
	return (
		p.card === 'model-import' &&
		p.action === 'architecture.import_model_exchange' &&
		p.http?.method === 'POST' &&
		p.http?.path === MODEL_IMPORT_ROUTE &&
		typeof p.input?.project_id === 'string' &&
		p.input.project_id.length > 0
	);
}

// ---------------------------------------------------------------------------
// fr-agui P2-c2 / SPEC §5.5 (F15) — the artifact FileCard: `artifacts.download`
// answers WHICH file it is (`revealable`); the card mints the single-use URL in the
// browser under the human's session (never through the agent).
// ---------------------------------------------------------------------------

export interface FileCardFile {
	artifact_id: string;
	project_id: string;
	filename: string | null;
	size: number | null;
	mime: string | null;
}

/** The file an `artifacts.download` answer offers, or null when it is not a FileCard answer. */
export function fileCardOf(output: unknown): FileCardFile | null {
	const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
	if (o.revealable !== true) return null;
	const f = (o.file && typeof o.file === 'object' ? o.file : null) as Record<string, unknown> | null;
	if (!f || typeof f.artifact_id !== 'string' || typeof f.project_id !== 'string') return null;
	return {
		artifact_id: f.artifact_id,
		project_id: f.project_id,
		filename: typeof f.filename === 'string' ? f.filename : null,
		size: typeof f.size === 'number' ? f.size : null,
		mime: typeof f.mime === 'string' ? f.mime : null
	};
}

/**
 * The FileCard a tool result renders in a rail BOUND to `boundProject`: an
 * `artifacts.download` success whose file names THAT project — else null (no card).
 * The server already refuses another project's artifact; this keeps a card from
 * ever minting for a project the rail is not bound to.
 */
export function fileCardFor(action: unknown, status: unknown, output: unknown, boundProject: string | null | undefined): FileCardFile | null {
	if (action !== 'artifacts.download' || status !== 'success') return null;
	const f = fileCardOf(output);
	if (!f || typeof boundProject !== 'string' || boundProject === '') return null;
	return f.project_id.toLowerCase() === boundProject.toLowerCase() ? f : null;
}

/** "1.2 KB" — a human file size. */
export function humanSize(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// The diagram PNG card: `architecture.download_diagram_png` names WHICH picture;
// the card downloads it under the person's session (the agent never gets bytes).
// ---------------------------------------------------------------------------

export interface DiagramPngCard {
	kind: 'view' | 'uml_diagram';
	id: string;
	title: string;
	model_id?: string;
	revision_id?: string;
}

export function diagramPngCardFor(action: unknown, status: unknown, output: unknown): DiagramPngCard | null {
	if (action !== 'architecture.download_diagram_png' || status !== 'success') return null;
	const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
	if (o.downloadable !== true) return null;
	const d = (o.diagram && typeof o.diagram === 'object' ? o.diagram : null) as Record<string, unknown> | null;
	if (!d || (d.kind !== 'view' && d.kind !== 'uml_diagram') || typeof d.id !== 'string' || d.id === '') return null;
	return {
		kind: d.kind,
		id: d.id,
		title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'diagram',
		...(typeof d.model_id === 'string' && typeof d.revision_id === 'string' ? { model_id: d.model_id, revision_id: d.revision_id } : {})
	};
}
