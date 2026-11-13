<script lang="ts">
  // TopNav — THE app bar, one row, mounted once at the top of both shells:
  //   brand + sidebar toggle | section tabs | Workspace › Project | andon,
  //   liveness, user menu.
  // The tabs are the three top-level sections, each with its own sidebar:
  // Tenant (home + tenant assets), Administration (workspace admin) and
  // Super-admin. Administration and Super-admin appear only for users who can
  // see at least one of their rows — the same registry + visibility predicate
  // CmdK uses. Project pages keep their own project sidebar; there the Tenant
  // tab reads as current (a project lives inside the tenant).
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { sidebar } from '$lib/stores/sidebar.svelte';
  import { LivenessBadge } from '$lib/components/observability';
  import ThemeToggle from '$lib/components/ui/ThemeToggle.svelte';
  import BrandMark from '$lib/components/ui/BrandMark.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import WorkspaceSwitcher from '$lib/components/WorkspaceSwitcher.svelte';
  import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
  import AndonCord from '$lib/components/AndonCord.svelte';
  import PanelLeft from 'lucide-svelte/icons/panel-left';
  import { sectionForPath, sectionNavFor, toNavRoles, type NavSection } from './navConfig';
  import { isProjectShellRoute } from './shellKind';

  let { onOpenActivity }: { onOpenActivity?: () => void } = $props();

  // The workspace role (auth.tenantRoles) is published by the workspaces store.
  // Load it here so a page opened directly has its role before any role-gated
  // row or tab is decided.
  onMount(() => {
    if (auth.isAuthenticated && !workspaces.loaded) void workspaces.load();
  });

  const roles = $derived(toNavRoles(auth.tenantRoles));
  const ctx = $derived({ isSuperAdmin: auth.isSuperAdmin });
  const inProject = $derived(isProjectShellRoute(page.route.id));

  /** A section's landing page: its first visible row, or null when it has none. */
  function firstHref(section: NavSection): string | null {
    return sectionNavFor(section, roles, ctx)[0]?.items[0]?.href ?? null;
  }

  const tabs = $derived(
    (
      [
        { section: 'tenant', label: 'Tenant', href: '/' },
        { section: 'admin', label: 'Administration', href: firstHref('admin') },
        { section: 'super', label: 'Super-admin', href: firstHref('super') },
      ] as { section: NavSection; label: string; href: string | null }[]
    ).filter((t) => t.href !== null),
  );

  const current = $derived(sectionForPath(page.url.pathname));

  let showUserMenu = $state(false);

  async function handleLogout() {
    showUserMenu = false;
    await auth.logout();
  }

  function handleManageAccount() {
    // In-app account page — deliberately NOT the external Keycloak account
    // console (auth.nonagentic.ai). See /settings/account.
    showUserMenu = false;
    void goto('/settings/account');
  }
</script>

<!-- ⚠️ THIS BAR MUST DEGRADE, NEVER CLIP.
     The shells are deliberately `overflow-hidden`, so anything pushed past the
     right edge is cut off with no scrollbar to recover it (the agent rail
     narrows the page further). Do NOT "fix" a recurrence with
     `overflow-x-auto`: a horizontally scrolling app chrome is a worse bug.
     Bound and degrade the content instead.

     THE LADDER, widest to narrowest:
       1. the switchers shrink (shrink-[9999] — they absorb pressure first)
          and truncate inside their per-breakpoint max-widths;
       2. below lg (1024px) the user's NAME label is hidden — lowest-value
          text in the bar, and the avatar keeps the affordance;
       3. below md (768px) the brand WORD is hidden; the mark stays as the
          home link;
       4. the tab strip shrinks next (`min-w-0`), each tab truncating its
          label — still a link, still clickable;
       5. nothing else ever goes. The brand mark, sidebar toggle, AndonCord,
          LivenessBadge and the avatar button are `shrink-0` and stay
          visible + clickable. -->
<header
  data-testid="top-nav"
  class="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 lg:gap-4 lg:px-4"
>
  <!-- Brand + sidebar collapse toggle -->
  <div class="flex shrink-0 items-center gap-1">
    <a
      href="/"
      class="flex items-center rounded-[var(--radius-sm)] transition hover:opacity-80"
      aria-label="Non-Agentic AI — home"
      title="Non-Agentic AI"
    >
      <BrandMark size={26} showWord={!sidebar.collapsed} wordClass="hidden md:inline" />
    </a>
    <button
      type="button"
      class="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]"
      aria-label={sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-pressed={sidebar.collapsed}
      title={sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={() => sidebar.toggleCollapsed()}
    >
      <Icon icon={PanelLeft} size={16} />
    </button>
  </div>

  <!-- Section tabs -->
  <nav aria-label="Sections" class="flex min-w-0 shrink items-center gap-1 self-stretch">
    {#each tabs as t (t.section)}
      <a
        href={t.href}
        data-testid={`top-nav-${t.section}`}
        aria-current={current === t.section ? 'page' : undefined}
        title={t.label}
        class={`flex h-full min-w-0 items-center border-b-2 px-2 text-sm transition-colors lg:px-3 ${
          current === t.section
            ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent-strong)]'
            : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
        }`}><span class="truncate">{t.label}</span></a
      >
    {/each}
  </nav>

  <!-- Scope switchers — the shrinkable zone: [Workspace ▾] › [Project ▾].
       WorkspaceSwitcher hides itself for single-workspace users; ProjectSwitcher
       renders its own leading `›` and hides when there is nothing to pick. -->
  <div class="flex min-w-0 flex-1 shrink-[9999] items-center gap-2 lg:gap-3">
    <WorkspaceSwitcher />
    <ProjectSwitcher />
  </div>

  <!-- Interactive controls — never shrink, never hide. -->
  <div class="flex shrink-0 items-center gap-2 lg:gap-3" data-testid="header-controls">
    <!-- Andon cord — GLOBAL stop-the-line, visible to all. -->
    <AndonCord />
    <!-- Kanban liveness badge → opens the activity tray. In a project its bare
         "Idle" read as the open project's state (FR-PROJECT-HOME-REDESIGN D2);
         it measures the server-wide board-update pool, so say so there. -->
    <LivenessBadge
      onclick={() => onOpenActivity?.()}
      scopePrefix={inProject ? 'Board updates (all projects)' : ''}
    />
  </div>

  <!-- User Menu -->
  <div class="relative shrink-0">
    <button
      onclick={() => (showUserMenu = !showUserMenu)}
      class="flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] p-1.5 transition-colors hover:bg-[var(--color-surface-strong)]"
      aria-label="User menu"
      aria-expanded={showUserMenu}
    >
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] font-semibold text-[var(--color-on-primary)]"
      >
        {auth.user?.name?.charAt(0)?.toUpperCase() || 'U'}
      </div>
      <!-- The FIRST thing to go. `inline-block` (not `inline`) because
           overflow/ellipsis does not apply to an inline box. -->
      <span
        class="hidden max-w-[10rem] truncate text-sm font-medium text-[var(--color-text)] lg:inline-block"
        data-testid="header-user-name">{auth.user?.name || 'User'}</span
      >
    </button>

    {#if showUserMenu}
      <div
        class="absolute right-0 z-50 mt-2 w-64 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        role="menu"
      >
        <div class="border-b border-[var(--color-border)] px-4 py-3">
          <p class="text-sm font-medium text-[var(--color-text)]">{auth.user?.name || 'User'}</p>
          <p class="text-xs text-[var(--color-text-muted)]">{auth.user?.email || ''}</p>
        </div>

        <div class="flex items-center justify-between gap-3 px-4 py-2 text-sm text-[var(--color-text)]">
          <span>Theme</span>
          <ThemeToggle />
        </div>

        <div class="my-1 border-t border-[var(--color-border)]"></div>

        <button
          type="button"
          role="menuitem"
          onclick={handleManageAccount}
          class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
        >
          Manage account
        </button>

        <button
          type="button"
          role="menuitem"
          onclick={handleLogout}
          class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[var(--color-danger)] hover:bg-[var(--color-surface-strong)]"
        >
          Sign out
        </button>
      </div>
    {/if}
  </div>
</header>

<!-- Click outside to close menu.
     z-index MUST stay below the bar's stacking context (the bar is `relative
     z-30`). The menu itself is `absolute z-50`, but that z-50 is scoped INSIDE
     the bar's z-30 context — so a root-level overlay at z-40 renders ON TOP
     of the whole bar, including the menu, and swallows every click on
     "Manage account" / "Sign out" (they just close the menu, never fire).
     z-[25] sits above page content (≤ z-20) and below the bar. -->
{#if showUserMenu}
  <button
    type="button"
    class="fixed inset-0 z-[25] cursor-default"
    aria-label="Close user menu"
    onclick={() => (showUserMenu = false)}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        showUserMenu = false;
      }
    }}
  ></button>
{/if}
