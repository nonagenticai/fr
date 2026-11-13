/**
 * navCounts — sidebar badge counters.
 *
 * Polls the cross-project endpoints once per minute. When one fails we leave
 * the count at its last known value (defaulting to 0), so a transient backend
 * hiccup just leaves the badge stale instead of breaking the sidebar — and, for
 * approvals, SAYS SO (`pendingApprovalsStale`), because a kept number that is
 * indistinguishable from a fresh one is a stale reading presented as current.
 *
 * ⛔ A COUNT WITHOUT ITS SCOPE IS NOT A COUNT. `/api/approvals/all` answers for
 * a population the REQUEST decided (`X-Active-Tenant`) and the SERVER resolved
 * (a super-admin in their home view gets every workspace), and it STATES which
 * one in `scope` / `scope_tenant_id`. This store keeps both beside the number —
 * see `pendingApprovalsScope`. Discarding them is how the rail came to print a
 * fleet census beside the name of a workspace holding none of it.
 *
 * ⚠️ The three endpoints do NOT share a response shape, and reading them as if
 * they did is what broke the approvals badge: cards answer `{data: [...]}` and
 * are correctly counted by length, notifications answer `{data:{count}}`, and
 * approvals answer `{items, data, total}` where `items` is ONE PAGE and `total`
 * is the population. See `refreshApprovals`.
 */

import { authFetch } from '$lib/api/auth-fetch';

/**
 * How long one `nudge()` window stays open, in ms.
 *
 * Short enough that the badge agrees with the decision the operator just took
 * while they are still looking at the surface they took it on, long enough that
 * a burst of decisions collapses into one re-count. It is a ceiling on refresh
 * RATE (at most one per window), not a delay added to a single decision beyond
 * this value.
 */
const NUDGE_WINDOW_MS = 1_000;

class NavCountsState {
  /**
   * Pending approvals in the population `/approvals` shows you.
   *
   * ⛔ THIS NUMBER IS NOT PROJECT-SCOPED, AND A PROJECT-SCOPED SURFACE MUST NOT
   * RENDER IT. `GET /api/approvals/all` applies no roster filter and, for a
   * super-admin in their home view, drops `approvals.tenant_id` entirely — so
   * this counts EVERY workspace's pending rows. See `refreshApprovals` for why
   * that scope is the right one for the /approvals rail row.
   *
   * MEASURED 2026-09-15: the PROJECT rail row `needs-you`
   * (`/projects/<id>/needs-you`) badged this counter and read "Needs you 99+",
   * while the NeedsYouQueue widget on that same page read "Nothing needs you
   * right now. 🎉" — two counters over what the operator reads as one thing,
   * contradicting each other on one screen. The widget's half was a discard bug
   * (fixed in NeedsYouQueue.svelte); this half was a SCOPE bug and outlived it.
   * `navConfig.ts` no longer badges any project-scoped row with it, and
   * `navConfig.test.ts` pins that. A per-project count belongs to the surface
   * that can compute it — the widget already renders its own.
   */
  pendingApprovals = $state(0);
  unreadNotifications = $state(0);

  /**
   * Load state of `pendingApprovals` — THREE values, not a boolean.
   *
   * Distinguishes "0 approvals" from "we never got an answer", the distinction
   * PendingApprovalsCard used to make with its own private fetch. A boolean
   * would collapse `loading` into `unavailable` and flash "not available yet"
   * on every single page load before the first response landed.
   *
   * The sidebar badge ignores this — hiding at 0 is already right for all three
   * cases. Once `ready` it STAYS ready: a later transient failure leaves the
   * last known count on screen (see the class docstring), and calling that
   * "unavailable" would be a louder claim than the data supports. What it is
   * NOT allowed to do is pass for current — that distinction is
   * `pendingApprovalsStale`, a second field precisely because it is a second
   * question.
   *
   * ⚠️ A WORKSPACE SWITCH IS THE ONE THING THAT SENDS THIS BACKWARDS, to
   * `loading`. That is not a transient failure, it is a change of subject: the
   * count no longer describes anything on screen. See `#forgetApprovalsCount`.
   */
  pendingApprovalsState = $state<'loading' | 'ready' | 'unavailable'>('loading');

  /**
   * SCOPE of `pendingApprovals`, VERBATIM FROM THE ENVELOPE THAT CARRIED IT.
   *
   * ⛔ THE DEFECT (fr#1140's surviving half, measured 2026-09-26 on the prod
   * primary). This function read `total` and threw `scope` away, so the rail
   * printed `Approvals 5` beside a workspace switcher naming `fr-test` — and
   * `fr-test` held ZERO of those 5 (fleet pending 5 = `system` 3 +
   * `nonagentic-exec` 2; `workflow-improvement` 0 too). The 5 is correct for
   * the queue the badge OPENS and a lie about the workspace it sits NEXT TO.
   * fr#1140's second clause is "a scope-limited count published as the total";
   * this is its mirror image — a total published as if it were scoped — and it
   * survived one layer above where #1140 was fixed.
   *
   * ⭐ READ FROM THE RESPONSE, NEVER RE-DERIVED. Scope is a property of the
   * REQUEST HEADER (`authFetch` sets `X-Active-Tenant` from the active
   * workspace) as resolved by the BACKEND (`isSuperAdminHomeView` is true when
   * there is no override, which DROPS the `approvals.tenant_id` predicate), so
   * no amount of client-side reasoning recovers it — only the envelope knows.
   * Same rule and same reason as `listScope` on /approvals/+page.svelte, whose
   * vocabulary this deliberately mirrors rather than inventing a second one for
   * the same number.
   *
   * ⚠️ NOT a closed set here, unlike the decoder in `$lib/api/unified-client`.
   * That decoder fails CLOSED on an unlisted value — the whole /approvals page
   * renders its ErrorState — which is right for a page and wrong for a rail
   * counter: a scope vocabulary this store has not heard of must not take the
   * sidebar down. So it keeps the raw string and asks only the one question
   * that matters. See `pendingApprovalsScopeKind`.
   */
  pendingApprovalsScope = $state<string | undefined>(undefined);

  /**
   * `scope_tenant_id` from the same envelope: the tenant the count was confined
   * to, or `null` when it was confined to NONE.
   *
   * THREE-VALUED, and the third value is the whole point: `undefined` = the
   * server did not say (a pre-#855 image), `null` = it said "no confinement", a
   * string = that tenant. Collapsing absent into null would read an old
   * server's SILENCE as "fleet-wide" and stamp the qualifier on every count it
   * ever returns; collapsing it the other way would print "in this workspace"
   * over a fleet census. Neither claim is available from an absent field.
   */
  pendingApprovalsScopeTenantId = $state<string | null | undefined>(undefined);

  /**
   * What `pendingApprovals` counts, in the three values a badge can honestly
   * render: `'fleet'`, `'workspace'`, or `undefined` for "the envelope did not
   * say" (which must render as today's unqualified number, not as either claim).
   *
   * ⭐ TWO INDEPENDENT ENVELOPE STATEMENTS, EITHER OF WHICH MEANS FLEET.
   * `scope === 'all'` is the comparison /approvals makes, and its docblock
   * argues correctly that an equality against the single load-bearing value
   * degrades safely for values it has never heard of. The DIRECTION it degrades
   * in matters more here than there: this number sits beside a workspace NAME
   * with no sentence around it, so an unrecognised scope falling back to "in
   * this workspace" would restore the exact lie. `scope_tenant_id === null` is
   * the backend's own second statement of the same fact — both handlers pin it
   * to one rule ("`null` exactly when `scope` is `'all'`",
   * backend/src/routes/approvals.ts) — so a scope value this store cannot read
   * still cannot make the badge claim a confinement the server never reported.
   *
   * ⚠️ WRITTEN AS TWO SEPARATE `if`s, NOT ONE `||`, SO EACH STATEMENT IS ITS OWN
   * FALSIFIABLE LINE. An audit measured that deleting EITHER disjunct of the
   * former single condition left the whole suite green — redundancy nothing can
   * fail is decoration, and it is decoration that reads as a second fence.
   *
   * ⛔ THE FALLBACK DIRECTION, CORRECTED. The workspace branch used to fire on
   * `typeof scope === 'string'` as well, so a scope this store cannot read —
   * `''`, or a value added after this image shipped — WITH `scope_tenant_id`
   * ABSENT (not null: absent) claimed "in this workspace". That is the same lie
   * the fleet bug told, quieter, and reached by the path the docblock above says
   * it must not be. A CONFINEMENT IS A CLAIM ABOUT WHICH WORKSPACE, so the only
   * statement that can support it is the field that NAMES one. Unreachable
   * against today's backend — `APPROVAL_SCOPE` is a closed 4-value set and
   * `approvals.ts:4222,4227` emit `scope` and `scope_tenant_id` from one object
   * literal — which is exactly why it needed fixing before something reaches it.
   * Everything unrecognised now degrades to `undefined`: the bare count, which
   * is what this store renders when it was told nothing, and the only honest
   * output for an envelope it cannot read.
   *
   * ⚠️ Deliberately NOT a closed allow-list of the workspace-confining scopes.
   * That would be a SECOND copy of the backend's vocabulary in this repo, and
   * the first one already drifted into a production outage
   * (`unified-client.ts`'s decoder, 2026-09-23, now fenced by
   * `backend/tests/unit/lib/approval-scope-decoder-mirror.test.ts`). Asking
   * `scope_tenant_id` instead costs nothing reachable and cannot drift.
   */
  get pendingApprovalsScopeKind(): 'fleet' | 'workspace' | undefined {
    // Statement 1: the scope vocabulary's own word for "every workspace".
    if (this.pendingApprovalsScope === 'all') return 'fleet';
    // Statement 2: the backend saying, independently, that it confined the count
    // to no tenant. Holds for a scope string this store has never heard of.
    if (this.pendingApprovalsScopeTenantId === null) return 'fleet';
    // A confinement, only ever from the field that names the workspace.
    if (typeof this.pendingApprovalsScopeTenantId === 'string') return 'workspace';
    return undefined;
  }

  /**
   * Did the LAST refresh confirm `pendingApprovals`, or is it just the last
   * number we ever got?
   *
   * ⛔ THE HOLE THIS CLOSES. `refreshApprovals` deliberately keeps the last
   * known count when a refresh fails and leaves the state `ready` (see the
   * class docstring, which argues that policy and is still right). The
   * consequence was that a kept number was INDISTINGUISHABLE from a fresh
   * reading: nothing on the surface, and nothing in this store, separated "5
   * pending" from "5 pending as of some earlier minute". Keeping the number is
   * right; presenting it as current is not.
   *
   * ⚠️ TIME-stale, not SCOPE-stale, and the two get OPPOSITE treatments. A
   * count taken for another workspace is FORGOTTEN outright
   * (`#forgetApprovalsCount`), never marked, because no qualifier makes "5, but
   * about somewhere else" useful beside this workspace's name — whereas "5, as
   * of the last successful poll of THIS workspace" is genuinely worth keeping.
   */
  pendingApprovalsStale = $state(false);

  /**
   * Load state of `unreadNotifications` — the SAME three values, for the same
   * reason, mirroring `pendingApprovalsState` above field for field.
   *
   * ⛔ THE DEFECT. `refreshNotifications` had `if (!r.ok) return;` and a bare
   * `catch {}`, and `unreadNotifications` starts at 0. So a 503 on
   * `/api/me/notifications/unread-count`, or an envelope this store cannot
   * read, left the counter at 0 — and 0 is the value that means "your inbox is
   * clear". An unreadable count rendered as a MEASURED zero, with no error, no
   * log and nothing for a consumer to gate on. Same shape as the approvals
   * badge (fixed above), reached independently one method down.
   *
   * ⭐ Exposed publicly for the same reason `pendingApprovalsState` is: a badge
   * or headline cannot tell the two apart from the number alone, so the
   * distinction has to be a field it can read. The sidebar badge may keep
   * hiding at 0 — that is right for all three cases — but a surface that
   * SPEAKS the number ("you have 0 unread") must gate on this.
   *
   * Once `ready` it STAYS ready: a later transient failure leaves the last
   * known count on screen, and calling that "unavailable" would be a louder
   * claim than the data supports. Identical policy to the approvals half.
   */
  unreadNotificationsState = $state<'loading' | 'ready' | 'unavailable'>('loading');

  async refresh(): Promise<void> {
    await Promise.allSettled([
      this.refreshApprovals(),
      this.refreshNotifications(),
    ]);
  }

  /**
   * ⭐ THE QUESTION THIS BADGE ANSWERS, CHOSEN AND WRITTEN DOWN:
   * **"how many approvals are PENDING in the population /approvals shows you."**
   * Not "pending that I personally can act on". The badge is an invitation to
   * open the queue, so it must count the queue.
   *
   * ⛔ THE DEFECT. This used to call `GET /api/approvals?status=pending`, and
   * that endpoint (`handleListMyApprovals`) IGNORES `status` entirely — it
   * hard-codes `eq(approvals.status,'pending')` and then scopes the result to
   * *roster-eligible ∪ requested-by-me*. /approvals calls
   * `GET /api/approvals/all` (`handleListAllApprovals`), which applies NO
   * roster filter: project-lane ∪ null-project-lane within the tenant, and for
   * a super-admin in their home view, across EVERY tenant. Two endpoints, two
   * populations, one badge. Measured live: the header read `Pending 991` while
   * the badge read `Approvals 1` with the tooltip "1 pending approval". A
   * product owner reading "1" concludes the system is idle and never opens it.
   *
   * ⭐ WHY NOT "pending that I can act on", which is also defensible. Three
   * reasons, in order of weight:
   *  1. It would differ from the list in the SAME direction that produced this
   *     bug — a small number next to a big queue — just with a principled name
   *     on it. The brief for both surfaces is that they answer one question.
   *  2. There is no server-side counter for it. `canActOnApproval`
   *     ($lib/approvals/canAct) is "required approver AND has not already
   *     decided"; the *closest* endpoint, `?mine=1`, matches the roster half
   *     and not the already-decided half, so it is not that question either.
   *     Computing it truthfully means loading every pending row into the
   *     sidebar — the unbounded fetch this same change is removing from the
   *     queue page.
   *  3. Scope. A super-admin in their home view gets a CROSS-WORKSPACE queue
   *     here (`superAdminHome` drops the `approvals.tenant_id` predicate). A
   *     badge scoped to the home tenant while the list is not is the same
   *     disagreement one layer down. Asking the same endpoint makes the badge
   *     inherit that relaxation for free, rather than mirroring it in a third
   *     place that can drift.
   *
   * ⛔ `total`, NOT `rows.length`, AND `limit=1` IS WHAT MAKES THAT MANDATORY.
   * `total` counts the whole matching population; `items` is one page. The old
   * code read `rows.length`, which was only ever right because the old endpoint
   * never paginated. Asking for one row keeps the badge's payload at one row
   * while the number stays exact — read the other way round, this request
   * returns `items.length === 1` for a 991-row queue, so a reader of `.length`
   * here now reports `1` for every non-empty workspace on earth. The fallback
   * to a length exists for a pre-#855 server that sends no `total`, and is
   * deliberately the LAST resort, not the first.
   */
  private async refreshApprovals(): Promise<void> {
    // ⭐ THE WORKSPACE THIS COUNT IS BEING TAKEN FOR, captured before the wire.
    // `refreshForScope` writes `#countedScope` BEFORE it issues the refresh, so
    // a switch that lands mid-flight makes every write below stale. Same
    // `scopeAtStart` / `stale()` idiom as /approvals/+page.svelte:1091, and for
    // the same measured reason: nothing cancels an in-flight fetch, so without
    // this the PREVIOUS workspace's response settles LAST and parks its number
    // under the new workspace's name with state `ready` — indistinguishable
    // from a fresh reading of a workspace it was never about.
    const scopeAtStart = this.#countedScope;
    const stale = () => this.#countedScope !== scopeAtStart;
    try {
      const r = await authFetch('/api/approvals/all?status=pending&limit=1');
      // ⛔ BEFORE the `!r.ok` branch, not after. A late failure for the workspace
      // the operator has LEFT must not mark the fresh count stale, nor flip the
      // new scope's honest `loading` to `unavailable`: this response says nothing
      // about the workspace now on screen, in either direction.
      if (stale()) return;
      if (!r.ok) {
        // Never-loaded stays honest; an established count stays on screen — but
        // MARKED, because "the last number we got" and "the number now" are two
        // different claims and only the first one is true here.
        if (this.pendingApprovalsState === 'loading') this.pendingApprovalsState = 'unavailable';
        else this.pendingApprovalsStale = true;
        return;
      }
      const body = await r.json();
      // Second gate: `r.json()` is a second await, so the switch can land here
      // too. The page gates after its `Promise.all` for the identical reason.
      if (stale()) return;
      const total = body?.total;
      this.pendingApprovals =
        typeof total === 'number' && Number.isFinite(total) && total >= 0
          ? total
          : ((body?.items ?? body?.data ?? []) as unknown[]).length;
      // ⭐ KEPT, NOT DISCARDED. This is the half fr#1140 left open: the number
      // and the population it counted arrive in one envelope and only the number
      // used to survive. A consumer cannot recover the scope from the count.
      this.pendingApprovalsScope = typeof body?.scope === 'string' ? body.scope : undefined;
      this.pendingApprovalsScopeTenantId =
        typeof body?.scope_tenant_id === 'string'
          ? body.scope_tenant_id
          : body?.scope_tenant_id === null
            ? null
            : undefined;
      this.pendingApprovalsState = 'ready';
      // This reading IS current, whatever the previous one was.
      this.pendingApprovalsStale = false;
    } catch {
      /* leave at last known value — but do not keep calling it current */
      if (stale()) return;
      if (this.pendingApprovalsState === 'loading') this.pendingApprovalsState = 'unavailable';
      else this.pendingApprovalsStale = true;
    }
  }

  /**
   * ⛔ `?? 0` IS NOT A DEFAULT HERE, IT IS AN ANSWER. `{data:{count}}` is this
   * endpoint's envelope; a body that does not carry a finite number at that
   * path is a body this store could not read, and coercing it to 0 says "your
   * inbox is clear" on exactly the response that proves nothing of the kind.
   * The unreadable case now sets `unreadNotificationsState` instead of
   * inventing a count — see that field for the whole argument.
   */
  private async refreshNotifications(): Promise<void> {
    try {
      const r = await authFetch('/api/me/notifications/unread-count');
      if (!r.ok) {
        // Never-loaded stays honest; an established count stays on screen.
        if (this.unreadNotificationsState === 'loading')
          this.unreadNotificationsState = 'unavailable';
        return;
      }
      const body = await r.json();
      const count = body?.data?.count;
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        if (this.unreadNotificationsState === 'loading')
          this.unreadNotificationsState = 'unavailable';
        return;
      }
      this.unreadNotifications = count;
      this.unreadNotificationsState = 'ready';
    } catch {
      /* leave at last known value */
      if (this.unreadNotificationsState === 'loading')
        this.unreadNotificationsState = 'unavailable';
    }
  }

  #countedScope: string | undefined = undefined;
  #scopeSeen = false;

  /**
   * Refresh iff the active workspace has changed since the last refresh.
   *
   * ⛔ WHY THIS EXISTS. The counts are tenant-scoped server-side, but the caller
   * used to be a bare `refresh()` in SidebarNav's `onMount` — which runs BEFORE
   * the workspace store resolves, so the request carried no `X-Active-Tenant`
   * and the backend scoped it to the user's own tenant instead of the workspace
   * on screen. Measured live on fr.nonagentic.ai 2026-08-26, twice, on a clean
   * profile: `GET /api/approvals?status=pending` returned `{"data":[],"total":0}`
   * and the Approvals badge was ABSENT, while /approvals listed 23 pending rows
   * for that same workspace. It was still 0 at t+12s and t+32s — nothing re-keyed
   * this store, so the badge stayed wrong until the 60s poll or a manual switch.
   * A badge that reads 0 for the first minute of a session is worse than no
   * badge: it is an answer, and it is the wrong one.
   *
   * The dedupe lives here rather than in the component so it is unit-testable
   * without mounting the whole shell, and so there is exactly ONE owner of "when
   * do the counts refetch" — `switchTenant` used to be a second one, which is how
   * the fresh-login path ended up with none.
   *
   * `undefined` is a legitimate scope, not a "not ready" sentinel: a user with no
   * workspaces never gets an id, and skipping the fetch for them would leave every
   * count at 0 forever. So the cold-load `undefined -> id` transition costs one
   * extra request and self-corrects in about a second, instead of the previous 60.
   *
   * @returns whether a fetch was actually issued.
   */
  refreshForScope(scope: string | undefined): boolean {
    if (this.#scopeSeen && scope === this.#countedScope) return false;
    this.#scopeSeen = true;
    this.#countedScope = scope;
    // ⛔ DROP THE PREVIOUS WORKSPACE'S COUNT BEFORE THE NEW ONE LANDS. The
    // `stale()` gate in `refreshApprovals` stops a late response from WRITING
    // the wrong number; it cannot un-render the number already on screen. So
    // for the second or so between the switch and the new response, the rail
    // kept printing the workspace-you-just-left's figure under the workspace
    // you just picked — the same defect the response gate closes, entered
    // through state rather than through a race. /approvals does exactly this
    // (+page.svelte: `allApprovals = []`, `listScope = undefined`,
    // `loadedTotal = undefined` on a scope change) and for the same reason.
    //
    // ⭐ Unconditional, including the cold `undefined -> id` load where the
    // fields are already at their defaults and this is a no-op: an ordering
    // accident is not a rule, and the branch that would skip it is the branch
    // that would one day skip a real switch.
    this.#forgetApprovalsCount();
    void this.refresh();
    return true;
  }

  /**
   * Un-know the approvals count — it belongs to a workspace we have left.
   *
   * Back to `loading`, not `unavailable`: a request for the new scope is issued
   * in the same tick, so "we are finding out" is the true statement. The badge
   * hides at 0 (correct for all three states) and the surfaces that SPEAK the
   * number gate on the state, so both read as "asking" rather than as a measured
   * zero — and if that request fails, the existing `loading -> unavailable`
   * transition says so instead of resurrecting the old workspace's figure.
   */
  #forgetApprovalsCount(): void {
    this.pendingApprovals = 0;
    this.pendingApprovalsState = 'loading';
    this.pendingApprovalsScope = undefined;
    this.pendingApprovalsScopeTenantId = undefined;
    this.pendingApprovalsStale = false;
  }

  #nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Re-count soon because the USER just changed something a badge counts.
   *
   * ⛔ THE DEFECT THIS CLOSES. Until now the only writers of these counts were
   * the 60s poll in SidebarNav and `refreshForScope` on a workspace switch. So
   * an operator who decided an approval watched the Approvals badge and the
   * dashboard's "N pending" card keep the OLD number for up to a minute — the
   * one surface outside the queue that could have confirmed their decision
   * landed, quietly disagreeing with what they had just done. On a decide whose
   * callback failed that is worse than useless: the badge not moving reads as
   * "nothing happened", which is the reading that makes an operator re-press a
   * button on a decision that is already spent.
   *
   * ⭐ NOT A SECOND REFRESH PATH — it arms `refresh()`, the one this store
   * already has, and `refreshForScope` still owns the scope-keyed case. What is
   * added here is only WHEN, never HOW, so there is still exactly one place
   * that knows how to count.
   *
   * ⭐ HOW THE STAMPEDE IS BOUNDED, AND WHY THIS SHAPE RATHER THAN A DEBOUNCE.
   * The first call ARMS a window and every call inside it is dropped, so N
   * decisions in `NUDGE_WINDOW_MS` cost exactly ONE refresh (three requests),
   * and the refresh always lands within the window of the FIRST decision. A
   * trailing debounce — reset the timer on every call — was the obvious
   * alternative and is wrong here for a reason that only shows up under the
   * load that matters: a sustained run of decisions (a fast operator, a bulk
   * decide on another surface) keeps pushing the deadline out, so the badge
   * updates LAST rather than soon, which is the stale badge this exists to end.
   * Nothing is lost by dropping calls inside the window: the refresh fires at
   * the END of it and therefore counts every decision the window contained, and
   * a decision landing after it fires arms a fresh window.
   */
  nudge(): void {
    if (this.#nudgeTimer !== null) return;
    this.#nudgeTimer = setTimeout(() => {
      this.#nudgeTimer = null;
      void this.refresh();
    }, NUDGE_WINDOW_MS);
  }
}

export const navCounts = new NavCountsState();
