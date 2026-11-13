// tests/unit/lib/fr-issuable-apps.test.ts
//
// fr provisions only its own platform context — an ALLOWLIST (George,
// 2026-10-14 / 2026-10-21). Per person: fr + fr-frontend. Per tenant: the
// members of fr's licences bundles, measured 2026-10-21 from prod `bundle_app`.

import { test, expect, describe } from 'bun:test';

import {
  FR_BUNDLES,
  FR_PERSON_APPS,
  FR_TENANT_APPS,
  isFrBundle,
  isFrIssuable,
  isFrPersonApp,
  notIssuableDetail,
  notPersonAppDetail,
  selectAppsNotFrPersonApps,
} from '../../../src/lib/fr-issuable-apps';

const OTHER_PLATFORMS = [
  'agent', 'care-bus', 'strata-configurator', 'commonpractice', 'w2v', 'w2v-image', 'sales',
  'marketing', 'raise-my-tickets', 'core-app', 'chat-bridge-merqi', 'book-fulfillment',
];

describe('fr-issuable apps (allowlist)', () => {
  test('per person: exactly fr + fr-frontend', () => {
    expect([...FR_PERSON_APPS]).toEqual(['fr', 'fr-frontend']);
    expect(isFrPersonApp('fr')).toBe(true);
    expect(isFrPersonApp('fr-frontend')).toBe(true);
    for (const key of ['kanban', 'n8n', 'kag', 'coding', 'ingestion', 'signal', ...OTHER_PLATFORMS]) {
      expect(isFrPersonApp(key)).toBe(false);
    }
  });

  test("other platforms' apps (agent, care-bus, strata-configurator, CP, w2v, merqi) are refused", () => {
    for (const key of OTHER_PLATFORMS) expect(isFrIssuable(key)).toBe(false);
  });

  test('an unknown future key is refused by default', () => {
    expect(isFrIssuable('some-new-app-2027')).toBe(false);
    expect(isFrPersonApp('some-new-app-2027')).toBe(false);
  });

  test('ingestion is not in an fr bundle', () => {
    expect(isFrIssuable('ingestion')).toBe(false);
  });

  test('every fr-bundle member is tenant-issuable', () => {
    for (const key of [
      'fr', 'fr-frontend', 'kag', 'inference-router', 'artifacts', 'coding', 'workers', 'laya',
      'kanban', 'n8n', 'keycloak', 'licenses', 'improvement-loop', 'procedures', 'requirements',
      'secrets', 'skill-builder', 'tools', 'mcp', 'signal', 'metering', 'observability',
      'meta_prompt_core_actions', 'meta_prompt_discover_actions', 'kaizen_core_actions',
      'kaizen_discover_actions',
    ]) {
      expect(isFrIssuable(key)).toBe(true);
    }
  });

  test('per-person apps are a subset of the tenant apps', () => {
    for (const key of FR_PERSON_APPS) expect(FR_TENANT_APPS).toContain(key);
  });

  test('fr bundles', () => {
    expect([...FR_BUNDLES]).toEqual(['conveyor', 'non-agentic-ai', 'n8n-nodes', 'inference-router']);
    expect(isFrBundle('conveyor')).toBe(true);
    expect(isFrBundle('commonpractice')).toBe(false);
  });

  test('selects the refused keys, in request order', () => {
    expect(selectAppsNotFrPersonApps(['fr', 'kag', 'fr-frontend', 'care-bus'])).toEqual(['kag', 'care-bus']);
    expect(selectAppsNotFrPersonApps(['fr-frontend'])).toEqual([]);
  });

  test('refusal details say outside fr platform context and nothing attempted', () => {
    const d = notIssuableDetail(['care-bus']);
    expect(d).toContain('care-bus is outside fr');
    expect(d).toContain('fr bundle');
    expect(d).toContain('owning app');
    expect(d).toContain('Nothing was attempted');
    const p = notPersonAppDetail(['kag', 'agent']);
    expect(p).toContain('kag, agent are outside fr');
    expect(p).toContain('fr + fr-frontend per person');
    expect(p).toContain('Nothing was attempted');
  });
});
