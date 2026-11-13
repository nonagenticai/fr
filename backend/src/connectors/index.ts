// src/connectors/index.ts
// Registry mapping ConnectorKind -> Connector instance.
// Spec 2 Plan 2-B Track A.
//
// H1 follow-up: the removed `file` connector read an arbitrary path on the
// fr-backend pod's own filesystem (`/proc/self/environ` = every secret fr
// holds). The user routes still refuse the kind (USER_REFUSED_CONNECTOR_KINDS)
// and this registry refuses it too, so a stored `file` trigger row fails its
// run instead of reading anything. Every runtime path
// that fetches (the cron tick, test-connection) resolves its connector here.

import type { ConnectorKind } from '../types/connectors';
import { USER_REFUSED_CONNECTOR_KINDS } from '../types/connectors';
import type { Connector } from './types';
import { rssConnector } from './rss';
import { githubQueryConnector } from './github-query';
import { s3Connector } from './s3';
import { n8nWebhookConnector } from './n8n-webhook';

type RunnableConnectorKind = Exclude<ConnectorKind, 'file'>;

const registry: Record<RunnableConnectorKind, Connector> = {
  rss: rssConnector,
  github_query: githubQueryConnector,
  s3: s3Connector,
  n8n_webhook: n8nWebhookConnector,
};

/** Message prefix of the refusal; callers match on it to classify the throw. */
export const REFUSED_CONNECTOR_KIND_PREFIX = 'Connector kind refused: ';

export function getConnector(kind: ConnectorKind): Connector {
  if (USER_REFUSED_CONNECTOR_KINDS.has(kind)) {
    // fr-authored sentence; names the kind only, never any config value.
    throw new Error(
      `${REFUSED_CONNECTOR_KIND_PREFIX}${kind} (this connector kind is disabled and cannot run)`,
    );
  }
  const connector = registry[kind as RunnableConnectorKind];
  if (!connector) {
    throw new Error(`Unknown connector kind: ${kind}`);
  }
  return connector;
}

export { rssConnector, githubQueryConnector, s3Connector, n8nWebhookConnector };
export type { Connector, FetchedRecord, DecryptedSecret, DryRunResult, ConnectorError } from './types';
