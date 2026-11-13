// tests/unit/openapi-jwt-metadata-allowlist.test.ts
//
// The `metadata` description on POST /api/execution/approvals is the only
// place a typed client (n8n-nodes-fr copies it verbatim into its UI) learns
// what the JWT door does with that object. It said "plus passthrough context"
// while the door applied an allowlist and DROPPED every other key without an
// error — a caller "passing context through" lost it and was never told.
//
// This pins the prose to the code: every allowlisted key and every control key
// must be named, the counts must match, and the words "passthrough" must be
// scoped to the secret door. The mutation block proves the checker can fail.

import { describe, expect, test } from 'bun:test';
import { openapiSpec } from '../../src/capabilities/served-spec';
import {
  JWT_METADATA_ALLOWED_KEYS,
  JWT_METADATA_CONTROL_KEYS,
  JWT_METADATA_CONTROL_KEY_CODE,
} from '../../src/routes/execution-approvals';

type Schema = { description?: string; properties?: Record<string, Schema> };

function metadataDescription(spec: unknown): string {
  const s = spec as {
    paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>;
  };
  const schema = s.paths['/api/execution/approvals']?.post?.requestBody?.content?.['application/json']?.schema;
  return schema?.properties?.metadata?.description ?? '';
}

/** Offenders: keys the description fails to name, and count claims that are wrong. */
function findDrift(desc: string, allowed: readonly string[], control: readonly string[]): string[] {
  const out: string[] = [];
  // `list` is a substring of ordinary prose; match every key as a whole word.
  const names = (k: string) => new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(desc);
  for (const k of allowed) if (!names(k)) out.push(`allowed key not documented: ${k}`);
  for (const k of control) if (!names(k)) out.push(`control key not documented: ${k}`);
  if (!desc.includes(`${allowed.length} data keys`)) out.push(`allowlist count ${allowed.length} not stated`);
  if (!desc.includes(`${control.length} control keys`)) out.push(`control-key count ${control.length} not stated`);
  if (!desc.includes('DROPPED')) out.push('does not say unlisted keys are dropped');
  if (!desc.includes(JWT_METADATA_CONTROL_KEY_CODE)) out.push('does not name the 422 code');
  return out;
}

describe('openapi: JWT door metadata is documented as the allowlist it is', () => {
  const desc = metadataDescription(openapiSpec);

  test('CONTROL: the description exists and the constants are non-trivial', () => {
    expect(desc.length).toBeGreaterThan(100);
    // Non-vacuity only — the constants are not counted (the drift checker
    // derives its expected counts from the allowlists themselves).
    expect(JWT_METADATA_ALLOWED_KEYS.length).toBeGreaterThan(0);
    expect(JWT_METADATA_CONTROL_KEYS.length).toBeGreaterThan(0);
  });

  test('every allowlisted and control key is named, with the right counts', () => {
    expect(findDrift(desc, JWT_METADATA_ALLOWED_KEYS, JWT_METADATA_CONTROL_KEYS)).toEqual([]);
  });

  test('the old "passthrough context" wording is gone for the JWT door', () => {
    expect(desc).not.toContain('plus passthrough context');
    expect(desc).toContain('not a passthrough');
  });
});

describe('mutation control: the checker fails on a drifted description', () => {
  const desc = metadataDescription(openapiSpec);

  test('a key added to the allowlist but not the prose is caught', () => {
    const drift = findDrift(desc, [...JWT_METADATA_ALLOWED_KEYS, 'new_key_nobody_documented'], JWT_METADATA_CONTROL_KEYS);
    expect(drift).toContain('allowed key not documented: new_key_nobody_documented');
    expect(drift.some((d) => d.startsWith('allowlist count'))).toBe(true);
  });

  test('the original "passthrough" prose fails every check that matters', () => {
    const old = 'Resume coordinates { doingListId, boardId, todoListId?, card_type? } plus passthrough context (e.g. gate_terms)';
    const drift = findDrift(old, JWT_METADATA_ALLOWED_KEYS, JWT_METADATA_CONTROL_KEYS);
    expect(drift).toContain('control key not documented: pr_number');
    expect(drift).toContain('does not say unlisted keys are dropped');
  });
});
