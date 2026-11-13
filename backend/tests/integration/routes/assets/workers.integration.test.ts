import { describe, it, expect } from 'bun:test';
import {
  handleListWorkers,
  handleGetWorker,
  handleListWorkerProviders,
  handleListWorkerProviderModels,
  handleSendWorkerMessage,
  handleWorkerChatCompletions,
  handleCreateWorker,
  handleUpdateWorker,
  handleDeleteWorker,
} from '../../../../src/routes/assets/workers';

describe('workers asset routes are registered in server.ts', () => {
  const expected: Array<{ method: string; path: string; handler: Function }> = [
    { method: 'GET',    path: '/api/assets/workers',                                  handler: handleListWorkers },
    { method: 'POST',   path: '/api/assets/workers',                                  handler: handleCreateWorker },
    { method: 'GET',    path: '/api/assets/workers/providers',                        handler: handleListWorkerProviders },
    { method: 'GET',    path: '/api/assets/workers/providers/openai/models',          handler: handleListWorkerProviderModels },
    { method: 'GET',    path: '/api/assets/workers/test-worker',                      handler: handleGetWorker },
    { method: 'PUT',    path: '/api/assets/workers/test-worker',                      handler: handleUpdateWorker },
    { method: 'DELETE', path: '/api/assets/workers/test-worker',                      handler: handleDeleteWorker },
    { method: 'POST',   path: '/api/assets/workers/test-worker/message',              handler: handleSendWorkerMessage },
    // chat/completions is the one worker route that does NOT key by
    // :name — the handler routes on provider+model in the body.
    { method: 'POST',   path: '/api/assets/workers/chat/completions',                 handler: handleWorkerChatCompletions },
  ];

  // fr-agui P4b part 2: these rows are capability-derived (capabilities/operate/workers.ts) —
  // deriveRouter registers them, so the check is: the route resolves, first match, to a
  // capability whose bound handler IS this export of routes/assets/workers.ts.
  it.each(expected)('$method $path is registered', async ({ method, path, handler }) => {
    const { orderedRouteTable } = await import('../../../../scripts/route-overlap-pairs');
    const { compileRoutePattern } = await import('../../../../src/utils/router');
    const { getCapability } = await import('../../../helpers/capabilities');
    const { handlerRefOf } = await import('../../../helpers/capabilities');
    const row = orderedRouteTable().find((r) => r.method === method && compileRoutePattern(r.path).test(path));
    expect(row?.handler.startsWith('capability:')).toBe(true);
    const ref = handlerRefOf(getCapability(row!.handler.slice('capability:'.length))?.legacyHandler);
    expect(`${ref?.module}#${ref?.exportName}`).toBe(`src/routes/assets/workers.ts#${handler.name}`);
  });
});
