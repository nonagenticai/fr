// fr/backend/src/domain/bridge/registry.ts
//
// Central dispatch for per-producer ToolOutputSource adapters.
// See spec §Architecture: each producer (coding/kag/artifacts) registers a
// source here; the bridge route surface looks them up by ProducerId. Keeping
// this a tiny module (rather than splattering registration into each
// integration) means agent calls like
//   bridgeRegistry.get('coding').getOutput(...)
// stay a single hop away from any caller in the bridge domain.
import type { ProducerId, ToolOutputSource } from './types';
import { IntegrationError } from '../../integrations/_lib/errors';

export class ToolOutputRegistry {
  private sources = new Map<ProducerId, ToolOutputSource>();
  // Monotonic counter bumped on every mutation. Read by callers that cache
  // results keyed by registry identity (the bridge.list_sources AG-UI action's
  // idempotency key) so a partial-boot empty result can't poison a 24h cache.
  private _generation = 0;

  register(source: ToolOutputSource): void {
    this.sources.set(source.id, source);
    this._generation += 1;
  }

  get generation(): number {
    return this._generation;
  }

  get(id: ProducerId): ToolOutputSource {
    const found = this.sources.get(id);
    if (!found) {
      throw new IntegrationError({
        code: 'unknown_producer',
        message: `Unknown bridge producer: ${id}`,
        service: 'bridge',
      });
    }
    return found;
  }

  list(): ToolOutputSource[] {
    return Array.from(this.sources.values());
  }
}

export const bridgeRegistry = new ToolOutputRegistry();
