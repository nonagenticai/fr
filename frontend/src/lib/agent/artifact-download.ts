/**
 * fr-agui SPEC §5.5 / F15 (P2-c2) — the artifact FileCard's download, IN THE BROWSER,
 * under the HUMAN's session: mint the single-use URL
 * (`POST /api/assets/artifacts/:id/download-token`, whose url + token are
 * `secrets.output`), fetch it once, hand the bytes to the browser as a file. The
 * token never leaves this function — it is not shown, stored or given to the agent.
 * The same two calls the Artifacts library page makes (routes/library/artifacts).
 */
import { authFetch } from '$lib/api/auth-fetch';

export type DownloadOutcome = { ok: true } | { ok: false; status: number; message: string };

/** The refusal text the library page shows, by status. */
export function downloadFailureText(status: number): string {
	if (status === 401 || status === 403 || status === 404 || status === 410) {
		return 'The download link expired or the file is no longer available. Try again.';
	}
	return 'The download failed. Try again in a moment.';
}

function mintDownloadUrl(artifactId: string, projectId: string): Promise<Response> {
	return authFetch(`/api/assets/artifacts/${encodeURIComponent(artifactId)}/download-token`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// The FileCard is rendered only for the conversation's BOUND project
		// (MessageList fileCardFor): naming it as `bound_project_id` makes the mint
		// check the project (fr's read lane) and that the artifact names it. The
		// library page's own mint omits it (tenant-scoped, unchanged).
		body: JSON.stringify({ project_id: projectId, bound_project_id: projectId })
	});
}

function saveBlob(blob: Blob, filename: string): void {
	const href = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = href;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		URL.revokeObjectURL(href);
	}
}

export async function downloadArtifactFile(
	artifactId: string,
	projectId: string,
	filename: string | null
): Promise<DownloadOutcome> {
	try {
		const minted = await mintDownloadUrl(artifactId, projectId);
		if (!minted.ok) return { ok: false, status: minted.status, message: downloadFailureText(minted.status) };
		const body = (await minted.json()) as { data?: { url?: unknown } };
		const url = typeof body.data?.url === 'string' ? body.data.url : '';
		if (!url.startsWith('/api/assets/artifacts/')) return { ok: false, status: 0, message: downloadFailureText(0) };
		const file = await fetch(url);
		if (!file.ok) return { ok: false, status: file.status, message: downloadFailureText(file.status) };
		saveBlob(await file.blob(), filename || 'artifact');
		return { ok: true };
	} catch (err) {
		console.warn('[artifact-download] the download failed', err);
		return { ok: false, status: 0, message: downloadFailureText(0) };
	}
}
