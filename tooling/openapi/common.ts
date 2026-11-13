import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface OpenApiService {
  name: string;
  liveUrl: string;
  snapshotFile: string;
  clientDir: string;
  /** Data files the upstream repo ships (not part of its OpenAPI), snapshotted next to the spec. */
  artifacts?: UpstreamArtifact[];
}

/**
 * A data file of an upstream repo that fr's tests read instead of hand-typing
 * it (e.g. RM's default PM catalogue). Snapshotted VERBATIM from `repo@ref:path`
 * by sync-specs.ts, turned into `<clientDir>/src/generated/<name>.ts` by
 * generate-clients.ts (so `clients:generate --check` catches a hand edit), and
 * refreshed by every `openapi:sync` (never compared live: fr holds no token for the upstream repo).
 */
export interface UpstreamArtifact {
  name: string;
  repo: string;
  ref: string;
  path: string;
  snapshotFile: string;
  exportName: string;
}

/** `repo@ref:path` read through `gh api` (needs GH_TOKEN / gh auth that can read `repo`). */
export function fetchUpstreamArtifact(artifact: UpstreamArtifact): string {
  const proc = Bun.spawnSync({
    cmd: [
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${artifact.repo}/contents/${artifact.path}?ref=${encodeURIComponent(artifact.ref)}`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`gh api ${artifact.repo}@${artifact.ref}:${artifact.path} failed: ${proc.stderr.toString().trim()}`);
  }
  const body = proc.stdout.toString();
  JSON.parse(body); // must be JSON; throws otherwise
  return body;
}

const TOOLING_DIR = resolve(import.meta.dir);
export const FR_ROOT = resolve(TOOLING_DIR, '..', '..');
const REGISTRY_FILE = resolve(TOOLING_DIR, 'services.json');

export async function loadServices(): Promise<OpenApiService[]> {
  return await Bun.file(REGISTRY_FILE).json();
}

export function fromRoot(relativePath: string): string {
  return resolve(FR_ROOT, relativePath);
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function selectServices(
  services: OpenApiService[],
  requestedNames: string[],
): OpenApiService[] {
  if (requestedNames.length === 0) return services;

  const requested = new Set(requestedNames);
  const selected = services.filter((service) => requested.has(service.name));
  const missing = requestedNames.filter(
    (name) => !selected.some((service) => service.name === name),
  );

  if (missing.length > 0) {
    throw new Error(`Unknown services: ${missing.join(', ')}`);
  }

  return selected;
}
