// Fixture for tests/unit/db/database-url-no-fallback.test.ts — run ONLY as a subprocess
// `bun --no-env-file run` (NO bunfig test preloads, so tests/setup-env.ts's sentinel does not
// apply: this is the deployment shape). Not a `.test.ts`: never collected by a suite on its own.
//
// Prints one `PROBE_RESULT {json}` line:
//   imported      — importing config + db/client did not throw
//   configError   — message thrown by `config.database.url`
//   queryError    — message thrown by the first `queryClient` query (null if it resolved)
//   dbError       — root-cause message of the first drizzle `db` use
const out: Record<string, unknown> = { imported: false };
try {
  const { config } = await import('../../../src/config');
  const client = await import('../../../src/db/client');
  out.imported = true;
  try {
    void config.database.url;
    out.configError = null;
  } catch (err) {
    out.configError = (err as Error).message;
  }
  const settle = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => null,
        // drizzle wraps driver errors (DrizzleQueryError "Failed query: …"); report the root cause.
        (err) => ((err as Error).cause as Error | undefined)?.message ?? (err as Error).message,
      ),
      new Promise((r) => setTimeout(() => r('TIMEOUT'), Number(process.env.PROBE_WAIT_MS ?? '1500'))),
    ]);
  out.queryError = await settle((async () => client.queryClient`select 1 as one`)());
  out.dbError = await settle((async () => client.db.execute('select 1'))());
} catch (err) {
  out.importError = (err as Error).message;
}
console.log(`PROBE_RESULT ${JSON.stringify(out)}`);
process.exit(0);
