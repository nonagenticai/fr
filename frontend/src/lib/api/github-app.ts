// Client for the public Non-Agentic AI GitHub App install flow.
//
// Contract: ~/.claude/plans/public-github-app-usable.md
//   POST   /api/github-app/install-url         -> {url}            (workspace admin)
//   POST   /api/github-app/claims/:handle/confirm -> {data: installation} (workspace admin,
//          and only the user + workspace that started the install)
//   GET    /api/github-app/installations       -> {items: GithubAppInstallation[]}
//   DELETE /api/github-app/installations/:id   -> marks the binding revoked
//
// The callback (`GET /api/github-app/callback`) is not called from here: GitHub
// redirects the browser to it, and it redirects on to
// /settings/github?claim=<handle> | ?pending=1 | ?github_error=<code>. The callback
// never connects anything by itself: the settings page confirms the claim
// with the logged-in user's bearer (confirmClaim), and fr binds only when that
// user and workspace are the ones that started the install.

import { authFetch } from "./auth-fetch";
import {
  decodeResponse,
  itemsEnvelope,
  nullable,
  num,
  object,
  str,
} from "./response-shape";

export interface GithubAppInstallation {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  github_user_login: string | null;
  created_at: string;
  revoked_at: string | null;
}

const INSTALLATION = object({
  id: str,
  installation_id: num,
  account_login: str,
  account_type: str,
  github_user_login: nullable(str),
  created_at: str,
  revoked_at: nullable(str),
});

const INSTALL_URL = object({ url: str });

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (resp.ok) return;
  let detail = "";
  try {
    const text = await resp.text();
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = String(j.message ?? j.error ?? text);
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    `${label} failed (${resp.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
  );
}

/** A fresh, single-use install URL on github.com carrying a signed state. */
export async function getInstallUrl(): Promise<string> {
  const endpoint = "/api/github-app/install-url";
  const resp = await authFetch(endpoint, { method: "POST" });
  await ensureOk(resp, "Getting the GitHub install link");
  const body = await decodeResponse(resp, INSTALL_URL, {
    endpoint,
    method: "POST",
  });
  if (!/^https:\/\/github\.com\//.test(body.url)) {
    throw new Error("The install link did not point at github.com");
  }
  return body.url;
}

/** A failed call that carries fr's machine-readable `code`, when it sent one. */
export class GithubAppApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "GithubAppApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Confirm the pending claim the install callback parked (`?claim=<handle>`).
 * Resolves with the connected account login. Rejects with a GithubAppApiError
 * whose `code` is one of claim_not_found | claim_not_yours |
 * bound_to_other_tenant | workspace_admin_required (or null).
 */
export async function confirmClaim(handle: string): Promise<string> {
  const endpoint = `/api/github-app/claims/${encodeURIComponent(handle)}/confirm`;
  const resp = await authFetch(endpoint, { method: "POST" });
  if (!resp.ok) {
    let code: string | null = null;
    try {
      const j = (await resp.json()) as { code?: unknown };
      if (typeof j.code === "string") code = j.code;
    } catch {
      /* body was not JSON — the status alone is reported */
    }
    throw new GithubAppApiError(
      `Connecting the GitHub installation failed (${resp.status})`,
      resp.status,
      code,
    );
  }
  const body = await decodeResponse(resp, object({ data: INSTALLATION }), {
    endpoint,
    method: "POST",
  });
  return body.data.account_login;
}

export async function listInstallations(): Promise<GithubAppInstallation[]> {
  const endpoint = "/api/github-app/installations";
  const resp = await authFetch(endpoint);
  await ensureOk(resp, "Loading connected GitHub accounts");
  const body = await decodeResponse(resp, itemsEnvelope(INSTALLATION), {
    endpoint,
  });
  return body.items as GithubAppInstallation[];
}

export async function disconnectInstallation(id: string): Promise<void> {
  const resp = await authFetch(
    `/api/github-app/installations/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  await ensureOk(resp, "Disconnecting");
}

/**
 * Open the GitHub install page in a NEW tab. The tab is opened synchronously
 * (inside the click) so a popup blocker does not eat it, then pointed at the
 * signed URL once the POST returns. If no tab could be opened, falls back to
 * navigating this one.
 */
export async function openInstallInNewTab(): Promise<void> {
  const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
  try {
    const url = await getInstallUrl();
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** The GitHub org that owns every repository the INTERNAL app already covers. */
export const INTERNAL_GITHUB_OWNER = "nonagenticai";

/** Owner of a github.com repository URL (https or ssh form), or null. */
export function githubOwnerOf(url: string): string | null {
  const s = url.trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/[^/\s]+/i.exec(s) ??
    /^git@github\.com:([^/\s]+)\/[^/\s]+/i.exec(s);
  return m ? m[1] : null;
}

/**
 * The owner to offer "Install the Non-Agentic AI GitHub App on <owner>" for, or
 * null when that offer would not help: only a `private_ungranted` verdict on a
 * github.com repo outside nonagenticai (which the internal app already covers).
 */
export function installCtaOwner(
  v: { url: string; access_state: string } | null | undefined,
): string | null {
  if (!v || v.access_state !== "private_ungranted") return null;
  const owner = githubOwnerOf(v.url);
  if (!owner || owner.toLowerCase() === INTERNAL_GITHUB_OWNER) return null;
  return owner;
}

export const INSTALL_ERROR_MESSAGES: Record<string, string> = {
  not_org_admin:
    "Your GitHub account is not an owner (admin) of that organization, so it was not connected. Ask an organization owner to install the app from this page.",
  not_account_owner:
    "That installation is on a personal GitHub account that is not yours, so it was not connected. Its owner must install the app from their own Non-Agentic AI account.",
  claim_not_yours:
    "That GitHub installation was started by a different Non-Agentic AI user or workspace, so it was not connected here. Start the installation again from this page.",
  claim_not_found:
    "The GitHub installation link expired or was already used. Start the installation again from this page.",
  workspace_admin_required:
    "Only a workspace admin can connect GitHub accounts to this workspace.",
  invalid_state:
    "The install link expired or was already used. Start the installation again from this page.",
  not_your_installation:
    "GitHub did not confirm that your GitHub account can see that installation, so it was not connected. Sign in to GitHub as a member who installed it and try again.",
  bound_to_other_tenant:
    "That GitHub installation is already connected to a different workspace. Disconnect it there first, or install the app on another account.",
  github_app_not_configured:
    "The GitHub App is not configured on this server yet. Contact your administrator.",
  claim_failed:
    "The GitHub installation could not be connected. Reload this page to see whether it was, or start the installation again.",
};

export function installErrorMessage(code: string): string {
  return (
    INSTALL_ERROR_MESSAGES[code] ??
    `The GitHub installation could not be completed (${code}).`
  );
}
