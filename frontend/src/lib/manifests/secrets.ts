// Secrets manifest for AssetWorkspace.
//
// Backend route: backend/src/routes/assets/secrets.ts (list / get / create only;
// NO update, NO delete by design — see `integrations/secrets.ts` for rationale).
// Upstream model: @fr/service-client-secrets (SecretListItem / SecretRetrieveResponse /
// SecretData / SecretResponse).
//
// Plan note vs reality (Wave 6 per-asset table claims `titleField: 'name'`,
// `searchableFields: ['name']`, `idField: 'name'`):
//   - Backend has no `name` field. The human-friendly label is `identifier`,
//     and the URL/route identifier is `secret_id` (the route is
//     `GET /api/assets/secrets/:secretId`).
//   - Per task brief: "the backend is canonical" — so we deviate from the table:
//     idField='secret_id', titleField='identifier', searchableFields=['identifier','secret_id'].
//
// Redaction: the upstream GET returns *decrypted* secret values. We never
// surface those: the detail view formats BOTH `secrets` AND `env_vars` as a
// list of redacted keys (`KEY: ***`), through ONE shared formatter
// (`formatSecretsRedacted`) so the two fields cannot drift apart again.
//
// ⚠️ CORRECTED 2026-09-25 — this block previously read: "`env_vars` are shown
// verbatim (they're conceptually less sensitive — same convention as
// `process.env` dumps in operational tools)." That was a plaintext-secret
// exposure, not a style preference, and the decision is now the opposite:
// `env_vars` gets the SAME unconditional redaction as `secrets`.
//   Why the old reasoning fails. "Conceptually less sensitive" is a claim about
//   what a user OUGHT to put in the field, not about what the field can HOLD.
//   Nothing in the editor, the manifest or the backend stops a user pasting a
//   token into `env_vars` — in the editor the two fields are visually identical
//   `type: 'json'` textareas — and once pasted the value was echoed into the DOM
//   on every subsequent detail-page view, forever, on an entity literally named
//   "Secret". A field on a Secret must not quietly not be one.
//   And the `process.env`-dump precedent does not transfer: those tools dump a
//   process's OWN environment to the operator running it, not one tenant's
//   stored credentials to a browser.
//
// Editor field types: AssetWorkspace has no `password` element type today
// (see AssetEditor.svelte field-type → element map). Per task brief we did
// NOT extend the workspace. The `secrets` and `env_vars` payloads are object
// maps (not flat strings), so the closest fit is `type: 'json'` — the user
// pastes/edits a JSON object. The `helpText` flags both fields as
// "write-only / not displayed after save" so the form UX makes the redaction
// contract clear.
//   ⚠️ CORRECTED 2026-09-25 — that last sentence was already written in the
//   plural ("both fields") but was only ever TRUE of `secrets`: the `env_vars`
//   editor field carried a bland "Optional. Object of {KEY: "value"} pairs."
//   and the `env_vars` detail field carried no `helpText` at all. So the two
//   visually identical fields gave the user OPPOSITE signals at entry time.
//   Both `env_vars` fields now carry the warning, and the sentence is true.

import type { AssetManifest } from '$lib/asset-workspace';
import { assetFetch } from '$lib/api/assets';

/**
 * Frontend-facing Secret shape.
 *
 * Mirrors the upstream `SecretRetrieveResponse` / `SecretListItem` envelope,
 * with `secrets` and `env_vars` typed as plain JSON objects so the manifest
 * editor's `type: 'json'` field can read/write them directly.
 *
 * Note: `secrets` AND `env_vars` are both `Record<string, string>` on the wire,
 * and the detail view's formatter reveals the values of neither (corrected
 * 2026-09-25 — it used to reveal `env_vars`). `value` is the synthetic
 * single-secret form alias used by the create form for the {KEY: VALUE}
 * payload — not a real backend field.
 */
export interface Secret {
  secret_id: string;
  user_id?: string;
  identifier: string;
  env_vars?: Record<string, string> | null;
  secrets?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
  ttl?: number | null;
  created_at?: string;
  updated_at?: string | null;
  expires_at?: string | null;
}

interface SecretListEnvelope {
  secrets: Secret[];
  total?: number;
}

function fmtDate(v: unknown): string {
  if (v == null || v === '') return '—';
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

/**
 * Render a secret-bearing object map for the detail view: list the keys, redact
 * every value. Used by BOTH the `secrets` and the `env_vars` detail fields.
 *
 * ⚠️ There is deliberately no escape hatch — no flag, no second formatter, no
 * `reveal` branch. It never reads `obj[k]`, so there is no code path on which a
 * stored value reaches the returned string. That is the whole safety property,
 * and it is why the sibling `formatEnvVars` (which rendered `KEY=value`
 * verbatim) was DELETED on 2026-09-25 rather than left unreferenced: a dead
 * formatter that still knows how to print plaintext is a re-arming hazard, one
 * `formatter:` line away from reinstating the exposure.
 *
 * Non-objects (including a JSON *string*) return '—' rather than being
 * stringified: this fails CLOSED, so an unexpected wire shape cannot leak.
 */
function formatSecretsRedacted(v: unknown): string {
  if (v == null) return '—';
  if (typeof v !== 'object') return '—';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '—';
  return keys.map((k) => `${k}: ***`).join('\n');
}

export const secretsManifest: AssetManifest<Secret> = {
  name: 'secrets',
  singular: 'Secret',
  plural: 'Secrets',
  group: 'support',
  // The route file `[secret_id]/+page.svelte` reads the URL segment and
  // hands it to AssetWorkspace; AssetList builds the same href via `idField`.
  idField: 'secret_id',
  api: {
    list: async (q) => {
      const params = new URLSearchParams(q ?? {}).toString();
      const env = await assetFetch<SecretListEnvelope>(
        `/api/assets/secrets${params ? `?${params}` : ''}`,
      );
      return { items: env?.secrets ?? [] };
    },
    get: (id) =>
      assetFetch<Secret>(`/api/assets/secrets/${encodeURIComponent(id)}`),
    create: (input) =>
      assetFetch<Secret>('/api/assets/secrets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    // No update, no remove — backend exposes neither (see route file).
  },
  list: {
    // ⚠️ The `Secret ID` column was dropped here DELIBERATELY, and the detail
    // view's `secret_id` field was deliberately KEPT. A uuid column beside the
    // human `identifier` in a table keyed on that identifier is noise a reader
    // has to skip past, but deleting the id everywhere would destroy the only
    // value an operator can paste into `GET /api/assets/secrets/:secretId`. So
    // there is exactly ONE place to read it — the detail Identity section —
    // plus the URL, and every list/heading surface speaks the human name.
    columns: [
      { key: 'identifier', label: 'Identifier', width: '24rem' },
      {
        key: 'created_at',
        label: 'Created',
        formatter: (v) => fmtDate(v),
      },
      {
        key: 'expires_at',
        label: 'Expires',
        formatter: (v) => fmtDate(v),
      },
    ],
    titleField: 'identifier',
    // No subtitle rather than the uuid that used to sit here: the heading
    // already carries the only human name a secret has, and repeating its
    // storage id underneath answers a question nobody asked. `searchableFields`
    // still matches on `secret_id`, so pasting one in still finds the row.
    searchableFields: ['identifier', 'secret_id'],
    defaultSort: { key: 'created_at', dir: 'desc' },
  },
  detail: {
    sections: [
      {
        title: 'Identity',
        fields: [
          { key: 'identifier', label: 'Identifier', type: 'text', required: true },
          { key: 'secret_id', label: 'Secret ID', type: 'text' },
        ],
      },
      {
        title: 'Values',
        fields: [
          // ⛔ `type: 'longtext'` on BOTH fields below is LOAD-BEARING for the
          // redaction — it is not a cosmetic choice, and `type: 'json'` here
          // would re-open the exposure even with `formatter` still attached.
          // Measured in AssetDetail.svelte: the `{#if field.type === 'json' &&
          // isPlainObject(value) …}` branch renders `entryList(value)` — raw
          // keys AND raw values — and RETURNS THERE. `field.formatter` is only
          // consulted in the final `{:else}`, via `renderField`. So the
          // formatter is unconditional *within* `renderField`, but reaching
          // `renderField` at all is conditional on this `type`.
          {
            key: 'secrets',
            label: 'Secrets',
            type: 'longtext',
            helpText: 'Values are redacted. Secrets cannot be revealed after save.',
            formatter: formatSecretsRedacted,
          },
          {
            key: 'env_vars',
            label: 'Environment variables',
            type: 'longtext',
            helpText: 'Values are redacted. Secrets cannot be revealed after save.',
            // Same formatter as `secrets` above — NOT a sibling that happens to
            // agree today. See the header retraction dated 2026-09-25.
            formatter: formatSecretsRedacted,
          },
        ],
      },
      {
        title: 'Lifecycle',
        fields: [
          {
            key: 'created_at',
            label: 'Created',
            type: 'text',
            formatter: (v) => fmtDate(v),
          },
          {
            key: 'updated_at',
            label: 'Updated',
            type: 'text',
            formatter: (v) => fmtDate(v),
          },
          {
            key: 'expires_at',
            label: 'Expires',
            type: 'text',
            formatter: (v) => fmtDate(v),
          },
        ],
      },
    ],
  },
  editor: {
    sections: [
      {
        title: 'Identity',
        fields: [
          {
            key: 'identifier',
            label: 'Identifier',
            type: 'text',
            required: true,
            helpText: 'User-friendly identifier, unique per tenant.',
          },
        ],
      },
      {
        title: 'Values',
        fields: [
          {
            key: 'secrets',
            label: 'Secrets (JSON object)',
            type: 'json',
            helpText:
              'Write-only. Object of {KEY: "value"} pairs. Values are NOT shown after save.',
          },
          {
            key: 'env_vars',
            label: 'Environment variables (JSON object)',
            type: 'json',
            // ⚠️ This warning is the POINT, not decoration. This field and
            // `secrets` above render as identical JSON textareas; before
            // 2026-09-25 only `secrets` warned, so the field that did NOT
            // redact was also the field that gave no signal at entry time.
            helpText:
              'Write-only. Object of {KEY: "value"} pairs. Values are NOT shown after save — redacted in the detail view exactly like Secrets.',
          },
        ],
      },
      {
        title: 'Lifecycle',
        fields: [
          {
            key: 'ttl',
            label: 'TTL (seconds)',
            type: 'number',
            helpText: 'Optional. 60–604800. Defaults to 1 hour upstream.',
          },
        ],
      },
    ],
  },
  // No delete API anyway — flag is moot, kept explicit for reviewers.
  destructiveActionsRequireConfirm: false,
};
