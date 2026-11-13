-- Migration: 235_drop_agent_skill_pins
-- Date: 2026-11-04
--
-- George 2026-11-04: skill_builder is retired, and the fr agent-skills feature that pinned a
-- tenant's skill_builder capability packs (agent/skills.ts, /api/agent-skills, the
-- /settings/agent-skills page) is deleted in the same change. This file is the schema half:
-- migration 195's `agent_skill_pins` goes. 195 stays as history. The agent's own in-repo packs
-- (agent/packs.ts) are unaffected — they never touched this table.
--
-- MEASURED ON PRODUCTION 2026-11-04, before writing this: 0 rows. Plain DROP, no CASCADE:
-- nothing references it (no FK in or out). Its two guard triggers from 195/142 drop with it.
--
-- (234 is taken by open fr#1719, 234_conveyor_failures_unattached.sql.)
--
-- Pure DDL, idempotent. Probed in src/db/migration-runner.ts (table absent).
-- RUNNER CONTRACT: no BEGIN/COMMIT.

SET LOCAL lock_timeout = '10s';

DROP TABLE IF EXISTS agent_skill_pins;
