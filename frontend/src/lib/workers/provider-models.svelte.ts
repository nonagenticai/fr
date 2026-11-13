// The provider -> model list behind every model picker (/chat, /workers/new,
// /workers/[name]) — fr#1407. One implementation, because the stale-model
// defect was found in all three copies.
//
// Invariants:
//   - `models` and `model` belong to `modelsFor` ONLY. A load ALWAYS drops the
//     previous provider's list and selection before fetching (also the first
//     load), so the old provider's models are never selectable — or saved /
//     sent — while the next provider's list is in flight.
//   - a response for a superseded load (a provider switch, a retry, an unmount)
//     is dropped, even when the provider NAME matches again (A -> B -> A: the
//     first A response must not land over the second).
//   - `sendable(provider)` (modelIsSendable) is the only gate a page may use
//     before persisting or sending a (provider, model) pair.
import { untrack } from 'svelte';
import {
  fetchProviderModels,
  modelIsSendable,
  pickDefaultModel,
  ProviderStateError,
  ProviderConfigError,
  type ProviderModel
} from './providers';
import { logRawError } from './wm-errors';

export type ProviderModelLoadOptions = {
  /**
   * A model to select once the list arrives, if the list offers it (an
   * existing worker's SAVED model). When the list does not offer it nothing is
   * auto-selected: `missingKept` names it, and the user must choose — the page
   * never silently swaps a saved model for a default.
   */
  keep?: string;
};

export class ProviderModelPicker {
  models = $state<ProviderModel[]>([]);
  model = $state('');
  /** The provider `models` was fetched for ('' while loading / after a failure). */
  modelsFor = $state('');
  loading = $state(false);
  /** A provider STATE sentence (fr#1385): not enabled / unavailable. Neutral. */
  notice = $state('');
  /** The list failed for any other reason; pages render providerModelsErrorText. */
  failed = $state(false);
  /** The kept (saved) model the fetched list does NOT offer; '' otherwise. */
  missingKept = $state('');
  /** A page-supplied reason no fetch is attempted (e.g. a provider needing a key). */
  blockedReason = $state('');

  #ctl: AbortController | null = null;
  #last: { provider: string; opts: ProviderModelLoadOptions } | null = null;

  /** Drop the list and selection. Separate so tests can probe the send gate alone. */
  protected reset(): void {
    this.models = [];
    this.model = '';
    this.modelsFor = '';
    this.loading = false;
    this.notice = '';
    this.failed = false;
    this.missingKept = '';
    this.blockedReason = '';
  }

  /**
   * Clear, then fetch `provider`'s models. Call from an `$effect` and return
   * its result, so a provider switch / unmount aborts the request. Writes are
   * untracked: the caller's effect depends only on what IT reads.
   */
  load(provider: string, opts: ProviderModelLoadOptions = {}): () => void {
    this.#ctl?.abort();
    const ctl = new AbortController();
    this.#ctl = ctl;
    this.#last = { provider, opts };
    untrack(() => {
      this.reset();
      this.loading = true;
    });
    fetchProviderModels(provider, ctl.signal)
      .then((list) => {
        // A response for a load that has since been superseded is ignored.
        if (ctl.signal.aborted || this.#ctl !== ctl) return;
        this.models = list;
        this.modelsFor = provider;
        this.loading = false;
        if (opts.keep) {
          const offered = list.some((m) => m.id === opts.keep);
          this.model = offered ? opts.keep : '';
          this.missingKept = offered ? '' : opts.keep;
        } else {
          // Prefers local-llm over list[0] (the selection was just cleared).
          this.model = pickDefaultModel(list, '');
        }
      })
      .catch((e: unknown) => {
        // AbortError is the expected path when the effect re-runs / unmounts.
        if (ctl.signal.aborted || this.#ctl !== ctl) return;
        this.reset();
        // ProviderStateError's message is a fixed client-side sentence; any
        // other failure carries status/statusText/detail — console only (fr#1409).
        if (e instanceof ProviderStateError || e instanceof ProviderConfigError) this.notice = e.message;
        else {
          logRawError('provider models', e);
          this.failed = true;
        }
      });
    return () => {
      ctl.abort();
      if (this.#ctl === ctl) this.#ctl = null;
    };
  }

  /** Re-run the last load (the "Try again" affordance). */
  retry(): void {
    if (this.#last) this.load(this.#last.provider, this.#last.opts);
  }

  /** No fetch: show `reason` instead (the provider cannot be served). */
  block(reason: string): void {
    this.#ctl?.abort();
    this.#ctl = null;
    untrack(() => {
      this.reset();
      this.blockedReason = reason;
    });
  }

  /** fr#1407: the model is in the list fetched for `provider`. */
  sendable(provider: string): boolean {
    return modelIsSendable(provider, this.model, this.modelsFor, this.models);
  }

  /** The list for `provider` loaded and is empty. */
  empty(provider: string): boolean {
    return (
      !this.loading &&
      !this.failed &&
      !this.notice &&
      !this.blockedReason &&
      this.modelsFor === provider &&
      this.models.length === 0
    );
  }
}
