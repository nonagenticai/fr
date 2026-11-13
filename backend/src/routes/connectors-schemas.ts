// src/routes/connectors-schemas.ts
//
// The POST /api/connectors/test-connection body (routes/connectors.ts), shared
// with its fr-agui P4b capability declaration (capabilities/settings/connectors.ts)
// so the declared input IS the route's. Side-effect free (zod + the connector
// kind list only).
import { z } from 'zod';

import { CONNECTOR_KINDS } from '../types/connectors';

export const ConnectorKindEnum = z.enum(CONNECTOR_KINDS as readonly [string, ...string[]]);

export const TestConnectionBody = z
  .object({
    kind: ConnectorKindEnum,
    config: z.unknown(),
    secret_id: z.string().uuid().optional(),
  })
  .strict();
