import { describe, it, expect } from 'vitest';
import { approvalUserLabel } from './user-label';
import type { Approval } from '$lib/types/api';

// fr review round 3: "Withdrawn by" printed the voider's raw uuid — the voider is
// in no roster/decision/requester slot, so only the server's voided_by_name names it.
const VOIDER = 'f14f8ba4-f075-4f97-b52e-c270b32a8266';
const base = { required_approvers: [], decisions: [] } as unknown as Approval;

describe('approvalUserLabel — the voider', () => {
	it('uses voided_by_name for the voider id', () => {
		const a = { ...base, voided_by: VOIDER, voided_by_name: 'Claude Oversight' } as unknown as Approval;
		expect(approvalUserLabel(a, VOIDER)).toBe('Claude Oversight');
	});

	it('falls back to the full uuid when the server could not resolve it', () => {
		const a = { ...base, voided_by: VOIDER, voided_by_name: null } as unknown as Approval;
		expect(approvalUserLabel(a, VOIDER)).toBe(VOIDER);
	});

	it('shows free-text voided_by as written', () => {
		const a = { ...base, voided_by: 'migration:114_one_open_gate_per_card' } as unknown as Approval;
		expect(approvalUserLabel(a, 'migration:114_one_open_gate_per_card')).toBe(
			'migration:114_one_open_gate_per_card'
		);
	});

	it('never lends the voider name to a different id', () => {
		const a = { ...base, voided_by: VOIDER, voided_by_name: 'Claude Oversight' } as unknown as Approval;
		const other = '00000000-0000-4000-8000-000000000001';
		expect(approvalUserLabel(a, other)).toBe(other);
	});
});
