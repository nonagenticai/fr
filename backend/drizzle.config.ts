// drizzle.config.ts
import type { Config } from 'drizzle-kit';

// No host fallback: drizzle-kit must be pointed at an explicit database (e.g. an
// ephemeral `docker run postgres:18`), never a developer box's localhost.
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  throw new Error('[fr] DATABASE_URL is unset: drizzle-kit refuses to fall back to a host database');
}

export default {
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url,
  },
} satisfies Config;
