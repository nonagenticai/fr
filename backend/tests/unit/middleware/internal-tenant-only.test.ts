import { test, expect, describe } from 'bun:test';
import { withRequestContextFromReq } from '../../../src/middleware/request-context';
import {
  INTERNAL_SYSTEM_TENANT_ID,
  assetStreamKindForCardType,
  isAssetAnalysisCardType,
  isAssetAuthoringCardType,
  isAssetCardType,
  isInternalTenant,
  refuseRetiredInternalSurface,
  requireAnyInternalTenant,
} from '../../../src/middleware/internal-tenant-only';
import { IntegrationError } from '../../../src/integrations/_lib/errors';

describe('asset analysis card_types (scoring half)', () => {
  const analysis = [
    'principle_statistics_analysis',
    'requirement_statistics_analysis',
    'decision_statistics_analysis',
  ];
  test('isAssetAnalysisCardType recognises the 3 governor-emitted analysis types', () => {
    for (const ct of analysis) expect(isAssetAnalysisCardType(ct)).toBe(true);
    expect(isAssetAnalysisCardType('principle_development')).toBe(false);
    expect(isAssetAnalysisCardType('workflow_statistics_analysis')).toBe(false);
    expect(isAssetAnalysisCardType(undefined)).toBe(false);
  });
  test('isAssetCardType covers authoring AND analysis, not the system kaizen types', () => {
    expect(isAssetCardType('principle_development')).toBe(true);
    for (const ct of analysis) expect(isAssetCardType(ct)).toBe(true);
    expect(isAssetCardType('workflow_statistics_analysis')).toBe(false);
    expect(isAssetCardType('procedure_performance_statistics_analysis')).toBe(false);
  });
  test('analysis types do NOT leak into the authoring set', () => {
    for (const ct of analysis) expect(isAssetAuthoringCardType(ct)).toBe(false);
  });
  test('assetStreamKindForCardType maps each analysis type to its kind (lock-step)', () => {
    expect(assetStreamKindForCardType('principle_statistics_analysis')).toBe('principle');
    expect(assetStreamKindForCardType('requirement_statistics_analysis')).toBe('requirement');
    expect(assetStreamKindForCardType('decision_statistics_analysis')).toBe('decision');
    // every isAssetCardType must resolve a kind (the route's unknown_asset_card_type invariant)
    for (const ct of analysis) expect(assetStreamKindForCardType(ct)).not.toBeNull();
  });
});

describe('isInternalTenant', () => {
  test('accepts the system tenant UUID', () => {
    expect(isInternalTenant(INTERNAL_SYSTEM_TENANT_ID)).toBe(true);
  });

  test('rejects the three deleted improvement tenants (2026-11-03)', () => {
    for (const id of [
      '0195f48b-d000-7000-8000-000000000002',
      '0195f48b-d000-7000-8000-000000000004',
      '0195f48b-d000-7000-8000-000000000005',
    ]) {
      expect(isInternalTenant(id)).toBe(false);
    }
  });

  test('rejects any other UUID', () => {
    expect(isInternalTenant('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  test('rejects undefined', () => {
    expect(isInternalTenant(undefined)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isInternalTenant('')).toBe(false);
  });
});

describe('requireAnyInternalTenant', () => {
  test('throws 404 IntegrationError when no tenant context is set', async () => {
    const req = new Request('http://x'); // no Authorization
    await withRequestContextFromReq(req, async () => {
      let caught: unknown;
      try {
        requireAnyInternalTenant('test');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IntegrationError);
      expect((caught as IntegrationError).code).toBe('UPSTREAM_NOT_FOUND');
    });
  });
});

describe('refuseRetiredInternalSurface', () => {
  test('always throws the opaque 404', async () => {
    const req = new Request('http://x');
    await withRequestContextFromReq(req, async () => {
      expect(() => refuseRetiredInternalSurface('g', 'test')).toThrow(IntegrationError);
    });
  });
});
