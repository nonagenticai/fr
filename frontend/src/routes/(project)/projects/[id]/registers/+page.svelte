<!--
  /projects/[id]/registers — the project's Registers (REG-3, FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.3).
  Two reads, each degrading on its own:
    - GET /api/projects/:id/registers (R2's proxy of RM's registers): risks, criteria, RM decisions.
      One read; the phase filter narrows it in the page, by the phase each row RECORDED.
    - GET /api/projects/:id/cockpit: the phase model (spine phases + Closure), the board's card names
      and the C8 decision log (the Decisions register until RM `decisions` has rows).
  A failed read says so (never an empty register); a project with no RM link says it keeps none.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { fetchProjectRegisters } from '$lib/api/project-registers';
  import { fetchProjectCockpit } from '$lib/api/cockpit';
  import { hasData } from '$lib/types/panel';
  import type { SpineCard } from '$lib/types/cockpit';
  import type { RegistersView } from '$lib/components/overview/overview';
  import ProjectRegisters from '$lib/components/registers/ProjectRegisters.svelte';
  import type { DecisionLogView } from '$lib/components/registers/registers';

  const projectId = $derived(page.params.id ?? '');

  let registers = $state<RegistersView>({ kind: 'reading' });
  let log = $state<DecisionLogView>({ kind: 'reading' });
  let phases = $state<{ name: string; label: string }[] | null>(null);
  let cards = $state<SpineCard[] | null>(null);
  /** The cockpit read failed: the phases, card names and decision log are unknown (said so, never faked). */
  let cockpitUnreadable = $state(false);

  async function loadRegisters(id: string): Promise<void> {
    try {
      const data = await fetchProjectRegisters(id, null);
      if (id === projectId) registers = { kind: 'loaded', data };
    } catch (e) {
      console.error('[projects/registers] registers read failed', e);
      if (id === projectId) registers = { kind: 'failed', message: e instanceof Error ? e.message : 'The registers could not be read.' };
    }
  }

  async function loadCockpit(id: string): Promise<void> {
    try {
      // PROJECT-READ-WAIVER: primary-load — not the project entity: this page needs the cockpit's spine
      // (phases + board card names) and C8 decision log, which loadProject does not carry; a failed read
      // renders data-testid="project-unreadable" below and the decision log says it could not be read.
      const c = await fetchProjectCockpit(id);
      if (id !== projectId) return;
      const spine = c.spine && hasData(c.spine) ? c.spine.data : null;
      phases = spine ? spine.phases.map((p) => ({ name: p.name, label: p.label })) : null;
      cards = spine ? spine.cards : null;
      log = c.decisions && hasData(c.decisions) ? { kind: 'loaded', rows: c.decisions.data } : { kind: 'failed' };
    } catch (e) {
      console.error('[projects/registers] cockpit read failed', e);
      if (id === projectId) {
        log = { kind: 'failed' };
        cockpitUnreadable = true;
      }
    }
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    registers = { kind: 'reading' };
    log = { kind: 'reading' };
    phases = null;
    cards = null;
    cockpitUnreadable = false;
    void loadRegisters(id);
    void loadCockpit(id);
  });
</script>

<div class="p-4">
  {#if cockpitUnreadable}
    <p class="mb-3 text-xs text-[var(--color-warning-text)]" data-testid="project-unreadable">
      This project's phases and decision log could not be read right now, so the phase filter uses the standard phases and
      card names are not shown.
    </p>
  {/if}
  <ProjectRegisters {projectId} view={registers} {log} {phases} {cards} />
</div>
