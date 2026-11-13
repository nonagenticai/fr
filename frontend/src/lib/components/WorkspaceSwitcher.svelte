<script lang="ts">
  // WorkspaceSwitcher.svelte — top-bar dropdown that lets the super-admin
  // switch the active workspace (system / execution / any workspace the
  // caller may switch into).
  //
  // Backed by the `workspaces` store. Persists the active id to
  // localStorage('fr.active_tenant'); `authFetch` reads the same key and
  // injects X-Active-Tenant on every backend request, so a switch is
  // effective starting with the very next call.
  //
  // Switching goes through `switchTenant()`. ⚠️ It is NOT the reload-free
  // soft-switch it once was, and that is deliberate: a soft switch only re-keys
  // the surfaces that opted in, so this control was measured INERT on 15 live
  // routes (identical rowCount, headHash AND firstRow before/after). Leaving an
  // entity route still soft-navigates; staying on the same route now rebuilds
  // the document. See the defect note at the top of `actions/switchTenant.ts`.

  import { onMount } from 'svelte';
  import { displayName } from '$lib/utils/displayName';
  import { workspaces, WORKSPACE_KIND_LABEL } from '$lib/stores/workspaces.svelte';
  import { switchTenant } from '$lib/actions/switchTenant';
  import { auth } from '$lib/stores/auth.svelte';

  onMount(async () => {
    if (auth.isAuthenticated && !workspaces.loaded) {
      await workspaces.load();
    }
  });

  // Re-hydrate on auth transitions (post-login mount before isAuthenticated flips).
  $effect(() => {
    if (auth.isAuthenticated && !workspaces.loaded) {
      void workspaces.load();
    }
  });

  function handleChange(ev: Event): void {
    const next = (ev.target as HTMLSelectElement).value;
    if (!next || next === workspaces.activeId) return;
    void switchTenant(next);
  }

  // The label the <select> is currently DISPLAYING, in full, in exactly the
  // `KIND · name` shape the <option>s use (and the single-workspace <span>
  // below). The control is width-capped, so this is what makes the cut text
  // recoverable instead of simply gone.
  const selectedLabel = $derived.by(() => {
    const w = workspaces.workspaces.find((x) => x.id === workspaces.activeId);
    return w ? `${WORKSPACE_KIND_LABEL[w.kind]} · ${displayName(w.name, w.id)}` : '';
  });
</script>

<!-- No `loaded` in this condition, on purpose: a failed load deliberately leaves
     `loaded` FALSE so the app's eight retry sites keep retrying. `error` is the
     signal that it broke; `loaded` stays "we have valid data". -->
{#if auth.isAuthenticated && workspaces.error && workspaces.workspaces.length === 0}
  <!-- `#loaded` is now set on the failure path too (see workspaces.svelte.ts
       `load()`), so this is reachable: a failed load used to render NOTHING
       here — identical to "you belong to exactly one workspace" (that case
       also renders nothing extra, just the plain span below) — and the user
       had no way to tell they couldn't switch workspace, or even that a
       switcher was supposed to be here at all. -->
  <button
    type="button"
    class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-1.5 text-sm text-[var(--color-danger)]"
    title={workspaces.error}
    data-testid="workspace-switcher-error"
    onclick={() => void workspaces.load()}
  >
    Workspaces unavailable — retry
  </button>
{:else if auth.isAuthenticated && workspaces.workspaces.length > 0}
  {#if workspaces.workspaces.length === 1}
    <span
      class="inline-flex min-w-0 max-w-[9rem] shrink truncate rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-muted)] md:max-w-[12rem] lg:max-w-[16rem]"
      title={`${WORKSPACE_KIND_LABEL[workspaces.workspaces[0].kind]} · ${displayName(workspaces.workspaces[0].name, workspaces.workspaces[0].id)}`}
      data-testid="workspace-switcher-single"
    >
      {WORKSPACE_KIND_LABEL[workspaces.workspaces[0].kind]} · {displayName(
        workspaces.workspaces[0].name,
        workspaces.workspaces[0].id,
      )}
    </span>
  {:else}
    <!-- ⚠️ min-w-0 + a capped max-width are load-bearing, not cosmetic. A bare
         <select> sizes to its widest <option>, and the header's right cluster
         used to be `flex-shrink-0`, so a long workspace name pushed the whole
         account cluster under ShellLayout's `overflow-hidden` edge — clipped,
         unreachable, no scrollbar. `min-w-0` lets flex shrink this below its
         intrinsic width; the max-width caps it before that is ever needed.
         Mirrors the idiom already in ProjectSwitcher.svelte.

         ⚠️ THE CAP ALONE WAS STILL A CLIP — it stopped the overrun and then ate
         the workspace name silently: no ellipsis, nothing to scroll, no hint
         that anything was lost. The <span> 20 lines up has always carried
         `truncate` + `title`; this <select> carried neither, which is why a
         live sweep at 768px found the tenant selector cut with no affordance on
         nearly every route. It is now recoverable three ways: the native
         dropdown lists every option at full width (pointer AND keyboard),
         `title` reveals the full `KIND · name` on hover/long-press, and
         `truncate` gives an ellipsis where the engine honours `text-overflow`
         on a <select>. ⛔ `truncate` is NOT sufficient on its own — engines
         disagree about it on a native <select>; `title` is the load-bearing
         half. The `md` cap steps to 10rem (was 12rem) because 768px is where
         the clip was measured and two 12rem switchers ate 384px of a header
         already short a sidebar's width; per TopNav.svelte's ladder the
         switchers are what absorbs that pressure. -->
    <select
      class="h-10 min-w-0 max-w-[9rem] shrink truncate rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none md:max-w-[10rem] lg:max-w-[16rem]"
      value={workspaces.activeId ?? ''}
      onchange={handleChange}
      title={selectedLabel}
      data-testid="workspace-switcher"
      aria-label="Active workspace"
    >
      {#each workspaces.workspaces as w (w.id)}
        <option value={w.id}>{WORKSPACE_KIND_LABEL[w.kind]} · {displayName(w.name, w.id)}</option>
      {/each}
    </select>
  {/if}
{/if}
