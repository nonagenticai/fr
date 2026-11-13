// tests/helpers/test-postgres-container.ts
//
// Pure argv builders for the per-file `docker run postgres:18` harnesses
// (tests/unit/db/migration-runner.test.ts,
// tests/unit/services/{agent-session,channels-registry}.test.ts,
// tests/integration/scripts/encrypt-credentials.integration.test.ts).
//
// ⛔ WHY THIS EXISTS: every one of those harnesses used to leak an ANONYMOUS
// VOLUME per run. The official postgres image declares a `VOLUME`, so a
// container started without a mount on that path gets a fresh anonymous volume;
// `--rm` would discard it on a clean exit, but the harnesses stop their
// container with `docker rm -f <name>`, which bypasses `--rm`'s cleanup and —
// without `-v` — leaves the volume behind. Run the suite a few hundred times and
// the Docker VM disk fills (it did, 2026-10-13).
//
// Two independent fixes, both applied:
//   1. A tmpfs mounted EXACTLY on the image's declared VOLUME path suppresses the
//      anonymous volume altogether (and the data dir is throwaway anyway).
//      postgres:18 moved the layout: `VOLUME /var/lib/postgresql` with
//      `PGDATA=/var/lib/postgresql/18/docker`. Mounting on the old
//      `/var/lib/postgresql/data` would NOT suppress it — and the 18 entrypoint
//      refuses to start when that old path is a mount point.
//   2. Every removal passes `-v`, so a container started from an image with a
//      different VOLUME (TEST_POSTGRES_IMAGE override) still takes its anonymous
//      volumes with it.

/** The VOLUME path postgres:18 declares (PGDATA lives below it). */
export const POSTGRES_VOLUME_PATH = '/var/lib/postgresql';

export const DEFAULT_TEST_POSTGRES_IMAGE = 'postgres:18';

export interface PostgresRunOptions {
  name: string;
  password: string;
  /** Defaults to `process.env.TEST_POSTGRES_IMAGE ?? 'postgres:18'`. */
  image?: string;
  db?: string;
}

/** argv (after `docker`) for starting a throwaway test Postgres that leaves no volume. */
export function postgresRunArgs(opts: PostgresRunOptions): string[] {
  const image = opts.image ?? process.env.TEST_POSTGRES_IMAGE ?? DEFAULT_TEST_POSTGRES_IMAGE;
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    opts.name,
    // Ephemeral host port; callers resolve it with `docker port`.
    '-p',
    '127.0.0.1::5432',
    // Suppresses the image's anonymous VOLUME (see header).
    '--tmpfs',
    POSTGRES_VOLUME_PATH,
    '-e',
    `POSTGRES_PASSWORD=${opts.password}`,
    '-e',
    `POSTGRES_DB=${opts.db ?? 'postgres'}`,
    image,
  ];
}

/** argv (after `docker`) for force-removing containers AND their anonymous volumes. */
export function containerRemoveArgs(namesOrIds: readonly string[]): string[] {
  return ['rm', '-f', '-v', ...namesOrIds];
}
