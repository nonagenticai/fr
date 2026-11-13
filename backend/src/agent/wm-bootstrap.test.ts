/**
 * Regression test for the WM 422 bug fixed 2026-05-01.
 *
 * worker_management/src/api/workers/models.py:371-377 has a model validator
 * that raises "agent_role is required when agent_type is provided". Before
 * this fix, buildConfig() set agent_type='pydantic-ai' (also wrong: WM only
 * accepts 'pydantic_ai' — see models.py:402) but never set agent_role, so
 * every POST /workers (and every internal create-on-demand) returned 422 —
 * and the loop's catch-and-stringify surfaced that 422 as the assistant's
 * reply text.
 */

import { test, expect } from 'bun:test';

import {
  buildConfig,
  FR_AGENT_DEFAULT,
} from './wm-bootstrap';

test('buildConfig sets agent_role so WM POST /workers does not 422', () => {
  const cfg = buildConfig(FR_AGENT_DEFAULT);
  expect(cfg.agent_role).toBeDefined();
  expect(typeof cfg.agent_role).toBe('string');
  expect(cfg.agent_role.length).toBeGreaterThan(0);
  expect(cfg.agent_type).toBe('pydantic_ai');
});

test('buildConfig propagates the worker name', () => {
  const cfg = buildConfig('some-other-worker');
  expect(cfg.worker_name).toBe('some-other-worker');
});
