// Who did something, in words: the member's display name from the workspace
// directory (members.svelte.ts), "(you)" for the signed-in user. A raw id is
// never printed. Reactive: a label rendered before the directory loads updates
// when it does.
import { auth } from '$lib/stores/auth.svelte';
import { memberDirectory } from './members.svelte';

export function personLabel(subjectId: string | null | undefined): string {
  if (!subjectId) return 'someone';
  const me = auth.user?.id === subjectId;
  memberDirectory.ensure();
  const status = memberDirectory.status;
  if (status === 'loading' || status === 'idle') return me ? 'you' : '…';
  if (status === 'failed') return me ? 'you' : 'a workspace member';
  const m = memberDirectory.member(subjectId);
  const name = m?.resolved ? (m.name?.trim() || m.email?.trim() || '') : '';
  if (!name) return me ? 'you' : 'a former member';
  return me ? `${name} (you)` : name;
}
