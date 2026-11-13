#!/usr/bin/env bun
/**
 * Create (or recreate) a database on the SAME server as $DATABASE_URL and print
 * its URL. `ci-test.sh` uses it to give the integration tree a fresh database
 * without a second postgres container.
 *
 *   bun run scripts/ci-create-db.ts <name>
 */
import postgres from 'postgres';

const name = process.argv[2];
if (!name || !/^[a-z_][a-z0-9_]*$/.test(name)) {
  console.error('usage: ci-create-db.ts <name>   (lowercase identifier)');
  process.exit(2);
}
const base = process.env.DATABASE_URL;
if (!base) {
  console.error('[ci-create-db] DATABASE_URL is unset');
  process.exit(2);
}
const sql = postgres(base, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE ${name}`);
} finally {
  await sql.end();
}
const url = new URL(base);
url.pathname = `/${name}`;
console.log(url.toString());
