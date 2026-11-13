import { writeFile } from 'node:fs/promises';
import {
  ensureParentDir,
  fetchUpstreamArtifact,
  fromRoot,
  loadServices,
  selectServices,
} from './common';

const REQUEST_TIMEOUT_MS = 15_000;

async function fetchOpenApi(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const requestedNames = process.argv.slice(2);
  const services = selectServices(await loadServices(), requestedNames);

  let failures = 0;

  for (const service of services) {
    const snapshotPath = fromRoot(service.snapshotFile);

    try {
      const spec = await fetchOpenApi(service.liveUrl);
      await ensureParentDir(snapshotPath);
      await writeFile(snapshotPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
      console.log(
        `[openapi:sync] ${service.name} -> ${service.snapshotFile} (${service.liveUrl})`,
      );
    } catch (error) {
      failures += 1;
      console.error(
        `[openapi:sync] ${service.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // The upstream's data artifacts, VERBATIM (never reformatted, never hand-edited).
    for (const artifact of service.artifacts ?? []) {
      try {
        const body = fetchUpstreamArtifact(artifact);
        const target = fromRoot(artifact.snapshotFile);
        await ensureParentDir(target);
        await writeFile(target, body, 'utf8');
        console.log(
          `[openapi:sync] ${service.name}/${artifact.name} -> ${artifact.snapshotFile} (${artifact.repo}@${artifact.ref}:${artifact.path})`,
        );
      } catch (error) {
        failures += 1;
        console.error(
          `[openapi:sync] ${service.name}/${artifact.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
