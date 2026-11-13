// project-registers.ts (api) — GET /api/projects/:id/registers?phase= (the RM #240 registers,
// proxied by fr: risks, decisions, requirements, criteria + counts). A failed read THROWS: the
// caller renders "could not be read", never an empty register.
import { authFetch } from './auth-fetch';
import type { ProjectRegisters } from '$lib/types/cockpit';

export async function fetchProjectRegisters(projectId: string, phase: string | null = null): Promise<ProjectRegisters> {
  const qs = phase ? `?phase=${encodeURIComponent(phase)}` : '';
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/registers${qs}`);
  if (!r.ok) throw new Error(`The registers could not be read (${r.status}).`);
  const body = (await r.json()) as { data?: ProjectRegisters };
  if (!body.data) throw new Error('The registers answer was empty.');
  return body.data;
}
