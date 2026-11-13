// src/lib/conveyor-configured-gate.ts
//
// The ONE refusal for project creation on an instance without the v4 conveyor
// wiring (config.ts `conveyorConfigured`). 503, body
// `{ error: 'conveyor_not_configured', code: 'conveyor_not_configured' }`.
//
// Called FIRST in every create door — before auth (validateAuth can upsert the
// caller's user row), before any idempotency lookup, DB write, RM call or Planka
// call — so a refused request leaves nothing behind.

import { CONVEYOR_NOT_CONFIGURED_CODE, conveyorConfigured } from '../config';
import { AppError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

export class ConveyorNotConfiguredError extends AppError {
  constructor() {
    super(503, CONVEYOR_NOT_CONFIGURED_CODE);
    this.name = 'ConveyorNotConfiguredError';
    this.code = CONVEYOR_NOT_CONFIGURED_CODE;
  }
}

/** The predicate itself, for a path that must refuse without a Response or a throw. */
export function conveyorIsConfigured(): boolean {
  return conveyorConfigured();
}

/** Throw the 503 when the conveyor is not wired. For non-handler create paths. */
export function assertConveyorConfigured(): void {
  if (!conveyorConfigured()) throw new ConveyorNotConfiguredError();
}

/** The 503 Response when the conveyor is not wired, else null. For handlers. */
export function conveyorNotConfiguredResponse(): Response | null {
  if (conveyorConfigured()) return null;
  return jsonResponse(
    { error: CONVEYOR_NOT_CONFIGURED_CODE, code: CONVEYOR_NOT_CONFIGURED_CODE },
    503,
  );
}
