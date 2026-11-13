<script lang="ts">
  // ProjectSwitcher.svelte — top-bar dropdown that selects the active PROJECT,
  // the inner working scope nested under the tenant: `[Tenant ▾] › [Project ▾]`.
  //
  // Backed by the `activeProject` store. Selecting a project OPENS it: on a
  // `/projects/<id>/<sub>` page the id is swapped and `<sub>` kept (Board stays
  // Board); anywhere else the user lands on /projects/<id>.
  //
  // ⛔ OUTSIDE A PROJECT THE CONTROL SHOWS A PLACEHOLDER, never the persisted
  // last project. It used to pre-select that project on tenant pages, so picking
  // the same project fired no `change` event and nothing happened — "I can't get
  // into a project in one click". Off the (project) route group the selected
  // option is "Open a project…" so EVERY pick navigates; inside a project it is
  // that project. The placeholder also stands until the list has loaded, so a
  // raw uuid never shows as the selected label. "No project" from
  // inside a project returns to the portfolio. Only the
  // real cockpit projects are listed — synthetic continuous (stream-backed)
  // boards are reached from the portfolio / kanban, not a /projects/[id] route.
  import { onMount } from 'svelte';
  import { displayName } from '$lib/utils/displayName';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { projectSwitchTarget } from '$lib/projects/project-switch-target';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeProject } from '$lib/stores/activeProject.svelte';
  import { isRealProject } from '$lib/projects/is-real-project';
  import { isProjectShellRoute } from '$lib/layout/shellKind';

  onMount(() => {
    if (auth.isAuthenticated && !activeProject.loaded) void activeProject.load();
  });

  // Discriminate on `kind`, NOT on an id prefix. This used to read
  // `!p.id.startsWith('stream:')`. The backend stopped minting that prefix (it
  // was not a uuid and produced SQLSTATE 22P02 → HTTP 500 when fed back into a
  // uuid column), and a prefix test against a bare uuid matches nothing — so
  // that filter would fail OPEN: continuous boards would leak into this
  // dropdown and `handleChange` would navigate to /projects/<stream-uuid>,
  // relocating the very 500 the id change removed. `kind` is the contract.
  const selectable = $derived(activeProject.projects.filter(isRealProject));

  /** The project the control shows: the open project, once names have loaded; else none (placeholder). */
  const shownId = $derived(
    isProjectShellRoute(page.route.id) && activeProject.loaded ? (activeProject.activeId ?? '') : '',
  );
  /**
   * The ACTIVE project when the list does not carry it — a closed project is left out of
   * `GET /api/projects`, and without its own option the <select> showed "No project" (F9). The
   * store resolves it by id; until it has, the option names it by its id, never "No project".
   */
  const unlistedActive = $derived(
    shownId && !selectable.some((p) => p.id === shownId)
      ? { id: shownId, name: activeProject.active?.name ?? null }
      : null,
  );

  const NONE = '__none__';

  function handleChange(ev: Event): void {
    const next = (ev.target as HTMLSelectElement).value;
    if (next === NONE) {
      const inProject = activeProject.openId !== undefined;
      activeProject.clear();
      if (inProject) void goto('/');
      return;
    }
    if (!next) return;
    activeProject.select(next);
    void goto(projectSwitchTarget(page.url.pathname, next));
  }

  // The label the control is currently DISPLAYING, in full. The <select> is
  // width-capped (see below), so at narrow widths the visible text is cut —
  // this is what makes the cut text recoverable rather than simply gone.
  const selectedLabel = $derived(
    (() => {
      if (!shownId) return 'Open a project…';
      const sel = selectable.find((p) => p.id === shownId);
      if (sel) return displayName(sel.name, sel.id);
      return displayName(activeProject.active?.name, shownId);
    })()
  );
</script>

{#if auth.isAuthenticated && (selectable.length > 0 || shownId)}
  <span class="shrink-0 text-[var(--color-border-strong)]" aria-hidden="true">›</span>
  <!-- `min-w-0` joins the pre-existing `max-w-[16rem]` cap: without it flex
       refuses to shrink a <select> below its widest <option>, and the header's
       right cluster then overruns ShellLayout's `overflow-hidden` edge. The
       max-width now steps down at narrow viewports for the same reason.

       ⚠️ A CAP WITHOUT AN AFFORDANCE IS STILL A CLIP. The cap above stopped the
       cluster overrunning, but it turned the project name into text that is
       simply GONE at narrow widths: no ellipsis, nothing to scroll, no hint
       that anything was lost. (Contrast the single-workspace <span> in
       WorkspaceSwitcher, which carries `truncate` — cut text WITH an ellipsis
       is a different, acceptable class.) Three things now make the value
       recoverable, in descending order of reliability:
         1. the native dropdown itself — opening it lists every option at full
            width with the current one marked, so the value is always reachable
            by pointer AND keyboard;
         2. `title` — hover/long-press reveals the full selected label;
         3. `truncate` — an ellipsis where the engine honours `text-overflow`
            on a <select>. ⛔ Do NOT rely on 3 alone: `text-overflow` is not
            honoured on a native <select> in every engine, which is exactly why
            2 is here and is the load-bearing half.
       The `md` cap is 10rem, not 12rem: 768px is where the live sweep measured
       the clip, two switchers at 12rem each ate 384px of a header that is
       already short a sidebar's width. Narrowing is the ladder TopNav.svelte
       documents (switchers absorb pressure first), and what is now cut is
       announced rather than silent. -->
  <select
    class="h-10 min-w-0 max-w-[9rem] shrink truncate rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none md:max-w-[10rem] lg:max-w-[16rem]"
    value={shownId}
    onchange={handleChange}
    title={selectedLabel}
    data-testid="project-switcher"
    aria-label="Active project"
  >
    {#if !shownId}
      <option value="" disabled selected>Open a project…</option>
    {:else}
      <option value={NONE}>No project</option>
    {/if}
    {#if unlistedActive}
      <option value={unlistedActive.id} data-testid="project-switcher-unlisted">{displayName(unlistedActive.name ?? undefined, unlistedActive.id)}</option>
    {/if}
    {#each selectable as p (p.id)}
      <option value={p.id}>{displayName(p.name, p.id)}</option>
    {/each}
  </select>
{/if}
