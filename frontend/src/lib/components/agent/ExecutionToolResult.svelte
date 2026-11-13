<!--
  fr-agui SPEC §5.3 / §13 P3 — the inline rendering of the project agent's
  execution-observability reads (projects.list_executions, get_wip,
  list_blocked_cards, list_agent_actions, list_cards_by_type,
  list_conveyor_executions). It renders the READ the agent made — the state the
  agent answered from — never the agent's prose. Output is `{ data }` from the
  route; it is redacted for display before anything is painted, and a body that
  does not name the thread's project is not rendered at all.
-->
<script lang="ts">
	import { redactForDisplay } from '$lib/api/agent-redact';

	let { action, output, projectId = null }: { action: string; output: unknown; projectId?: string | null } = $props();

	type Row = { key: string; text: string; sub?: string; href?: string };

	const data = $derived.by(() => {
		const d = (output as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
		if (!d || typeof d !== 'object') return null;
		if (projectId && d.project_id !== projectId) return null;
		return redactForDisplay(d);
	});

	function arr(v: unknown): Array<Record<string, any>> {
		return Array.isArray(v) ? (v as Array<Record<string, any>>) : [];
	}

	const view = $derived.by((): { title: string; rows: Row[]; note?: string } | null => {
		const d = data as Record<string, any> | null;
		if (!d) return null;
		switch (action) {
			case 'projects.list_blocked_cards':
				return {
					title: 'Blocked cards',
					rows: arr(d.cards).map((c) => ({
						key: String(c.id),
						text: String(c.name ?? c.id),
						sub: `${c.block_reason ?? 'no reason recorded'}${c.escalation ? ` · escalation: ${c.escalation.description}` : ''}`,
						href: typeof c.url === 'string' ? c.url : undefined
					})),
					note: d.available === false ? `unavailable (${d.reason})` : undefined
				};
			case 'projects.list_executions':
				return {
					title: "Runs (every member's)",
					rows: arr(d.runs).map((r) => ({
						key: String(r.id),
						text: `#${r.id} ${r.status ?? `status ${r.status_source}`}`,
						sub: `${r.initiated_by_me ? 'you' : (r.initiated_by ?? 'a member')} · ${r.triggered_at ?? ''}`
					}))
				};
			case 'projects.get_wip': {
				const l = d.limit ?? {};
				const b = d.board_count ?? {};
				return {
					title: 'WIP',
					rows: [
						{ key: 'limit', text: `limit ${l.available ? (l.effective_wip_limit ?? 'none') : 'unavailable'}`, sub: l.label ?? l.reason },
						{ key: 'board', text: `in DOING ${b.available ? b.doing : 'unavailable'}`, sub: b.label },
						{ key: 'headroom', text: `headroom ${d.headroom ?? '—'}`, sub: `enforced by ${d.enforced_by}` }
					]
				};
			}
			case 'projects.list_agent_actions':
				return {
					title: 'Agent activity',
					rows: arr(d.actions).map((a, i) => ({ key: String(i), text: `${a.capability ?? '?'} ${a.outcome}`, sub: `${a.by_me ? 'you' : (a.actor ?? 'a member')} · ${a.at ?? ''}` }))
				};
			case 'projects.list_cards_by_type':
				return {
					title: `Cards of type ${d.card_type}`,
					rows: arr(d.cards).map((c) => ({ key: String(c.id), text: String(c.name ?? c.id), sub: c.list_name ?? undefined, href: c.url })),
					note: d.known === false ? `unknown card type (${d.reason})` : undefined
				};
			case 'projects.list_conveyor_executions':
				return {
					title: 'Conveyor runs',
					rows: arr(d.runs).map((r) => ({ key: String(r.id), text: `#${r.id} ${r.status ?? ''}`, sub: r.started_at ?? undefined })),
					note: d.available === false ? `not available (${d.reason})` : undefined
				};
			default:
				return null;
		}
	});
</script>

{#if view}
	<div class="mt-2 space-y-1 text-xs" data-testid="agent-exec-result" data-action={action}>
		<p class="font-semibold">{view.title}</p>
		{#if view.note}<p class="text-[var(--color-text-muted)]" data-testid="agent-exec-note">{view.note}</p>{/if}
		{#if view.rows.length === 0 && !view.note}<p class="text-[var(--color-text-muted)]">none</p>{/if}
		<ul class="space-y-0.5">
			{#each view.rows as r (r.key)}
				<li data-testid="agent-exec-row">
					{#if r.href}<a href={r.href} class="hover:underline">{r.text}</a>{:else}<span>{r.text}</span>{/if}
					{#if r.sub}<span class="text-[var(--color-text-muted)]"> — {r.sub}</span>{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}
