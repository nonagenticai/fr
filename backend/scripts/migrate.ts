// Apply pending SQL migrations against $DATABASE_URL.
//
// CLI front-door for the same `applyMigrations` runner that server.ts
// calls at boot. Used by CI to prepare a fresh ephemeral Postgres before
// the unit-test suite runs (some `tests/unit/routes/tools/**` files refuse
// to skip on `CI=true` and need a real schema).
import { applyMigrations } from '../src/db/migration-runner';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

await applyMigrations(url);
console.log('[migrate] OK');
