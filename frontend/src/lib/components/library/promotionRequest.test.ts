import { describe, expect, it } from 'vitest';
import { canRequestPromotion, isPromotableCopy, promotionErrorText, promotionLabel } from './promotionRequest';

const P = '0195f48b-d000-7000-8000-00000000a8a1';
const copy = { origin_kind: 'project', origin_project_id: P, supersedes: 'use-postgres', version_status: 'DRAFT' };

describe('isPromotableCopy', () => {
  it('offers the action on a copy made in this project', () => {
    expect(isPromotableCopy('principle', copy, P)).toBe(true);
    expect(isPromotableCopy('decision', { ...copy, origin_project_id: P.toUpperCase() }, P)).toBe(true);
  });
  it('never on a workspace asset, another project, a non-copy or a merged copy', () => {
    expect(isPromotableCopy('principle', { ...copy, origin_kind: 'tenant' }, P)).toBe(false);
    expect(isPromotableCopy('principle', { ...copy, origin_project_id: 'other' }, P)).toBe(false);
    expect(isPromotableCopy('principle', { ...copy, supersedes: null }, P)).toBe(false);
    expect(isPromotableCopy('principle', { ...copy, version_status: 'SUPERSEDED' }, P)).toBe(false);
  });
});

describe('promotionLabel', () => {
  it('names each state, and nothing before a request', () => {
    expect(promotionLabel(null)).toBeNull();
    expect(promotionLabel({ approval_id: 'a', status: 'pending', promotion: null })).toMatch(/waiting for a workspace admin/);
    expect(promotionLabel({ approval_id: 'a', status: 'approved', promotion: { outcome: 'promoted' } })).toBe('Promoted to the workspace');
    expect(promotionLabel({ approval_id: 'a', status: 'approved', promotion: { outcome: 'failed' } })).toBe('Promotion failed — ask again');
    expect(promotionLabel({ approval_id: 'a', status: 'rejected', promotion: null })).toMatch(/declined/);
  });
});

describe('canRequestPromotion', () => {
  const st = (status: string, outcome?: string) => ({ approval_id: 'a', status, promotion: outcome ? { outcome } : null });
  it('offers a fresh request when nothing was asked, or the last one failed, was declined or expired', () => {
    expect(canRequestPromotion(null)).toBe(true);
    expect(canRequestPromotion(st('approved', 'failed'))).toBe(true);
    expect(canRequestPromotion(st('rejected', 'not_promoted'))).toBe(true);
    expect(canRequestPromotion(st('expired'))).toBe(true);
    expect(canRequestPromotion(st('voided'))).toBe(true);
  });
  it('never while one is pending, nor once the copy was promoted', () => {
    expect(canRequestPromotion(st('pending'))).toBe(false);
    expect(canRequestPromotion(st('approved', 'promoted'))).toBe(false);
    // Approved with no stamped outcome yet: not known to have failed, so not offered.
    expect(canRequestPromotion(st('approved'))).toBe(false);
  });
});

describe('promotionErrorText', () => {
  it('maps the refusal codes to plain lines and never shows upstream detail', () => {
    expect(promotionErrorText({ code: 'promotion_no_approver', message: '409 Conflict: x' })).toMatch(/no admin/);
    expect(promotionErrorText({ code: 'promotion_requires_project_member' })).toMatch(/members of this project/);
    const raw = promotionErrorText(new Error('502 Bad Gateway: requirements_management timed out'));
    expect(raw).toBe("Couldn't ask for promotion. Try again.");
    expect(raw).not.toMatch(/502|requirements_management/);
  });
});
