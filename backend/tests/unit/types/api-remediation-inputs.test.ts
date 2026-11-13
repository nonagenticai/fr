// tests/unit/types/api-remediation-inputs.test.ts
//
// IT_MVP Flow 2/3 — zod schema test for the ProjectCreateSchema remediation
// intake fields. These flow into project_data via projects.ts `...extendedFields`
// and AA Pattern - Done Finalize propagates them onto the
// development_security_patch / development_bug_fix card brief.

import { describe, expect, test } from 'bun:test';
import { ProjectCreateSchema } from '../../../src/types/api';

describe('ProjectCreateSchema remediation inputs (Flow 2/3)', () => {
  test('all remediation fields are optional (Flow 1 unchanged)', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
    });
    expect(parsed.min_severity).toBeUndefined();
    expect(parsed.test_command).toBeUndefined();
    expect(parsed.test_workdir).toBeUndefined();
    expect(parsed.bug_test_command).toBeUndefined();
    expect(parsed.failing_test_ref).toBeUndefined();
    expect(parsed.target_files).toBeUndefined();
    expect(parsed.finding_description).toBeUndefined();
    expect(parsed.bug_description).toBeUndefined();
  });

  test('accepts a fully-populated security remediation body', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      it_flow: 'security',
      min_severity: 'HIGH',
      test_command: ['python', '-m', 'pytest', '-q'],
      test_workdir: '.',
      target_files: ['src/app.py', 'requirements.txt'],
      finding_description: 'CVE-2024-XXXX in transitive dep',
    });
    expect(parsed.min_severity).toBe('HIGH');
    expect(parsed.test_command).toEqual(['python', '-m', 'pytest', '-q']);
    expect(parsed.test_workdir).toBe('.');
    expect(parsed.target_files).toEqual(['src/app.py', 'requirements.txt']);
    expect(parsed.finding_description).toBe('CVE-2024-XXXX in transitive dep');
  });

  test('accepts a fully-populated bug remediation body', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      it_flow: 'bug',
      bug_test_command: ['python', '-m', 'pytest', 'tests/test_foo.py::test_bar', '-q'],
      failing_test_ref: 'tests/test_foo.py::test_bar',
      bug_description: 'Off-by-one in pagination',
    });
    expect(parsed.bug_test_command).toEqual([
      'python',
      '-m',
      'pytest',
      'tests/test_foo.py::test_bar',
      '-q',
    ]);
    expect(parsed.failing_test_ref).toBe('tests/test_foo.py::test_bar');
    expect(parsed.bug_description).toBe('Off-by-one in pagination');
  });

  test('accepts the source-security + iac it_flow values (WS2 source/IaC drives)', () => {
    for (const it_flow of ['source-security', 'iac'] as const) {
      const parsed = ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        it_flow,
        min_severity: 'HIGH',
        test_command: ['python', '-m', 'pytest', '-q'],
        finding_description: 'bandit B602 subprocess shell=True',
      });
      expect(parsed.it_flow).toBe(it_flow);
    }
  });

  test('accepts it_flow "refactor" with refactor-shaped inputs', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      it_flow: 'refactor',
      target_files: ['src/aacyc_alpha/core.py', 'src/aacyc_beta/core.py'],
      test_command: ['python', '-m', 'src.aacyc_check'],
      test_workdir: '/workspace',
    });
    expect(parsed.it_flow).toBe('refactor');
    expect(parsed.target_files).toEqual([
      'src/aacyc_alpha/core.py',
      'src/aacyc_beta/core.py',
    ]);
    expect(parsed.test_command).toEqual(['python', '-m', 'src.aacyc_check']);
  });

  test('rejects an unknown it_flow enum value', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        it_flow: 'malware',
      } as unknown),
    ).toThrow();
  });

  test('rejects an invalid min_severity enum value', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        min_severity: 'severe',
      } as unknown),
    ).toThrow();
  });

  test('rejects a non-array target_files', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        target_files: 'src/app.py',
      } as unknown),
    ).toThrow();
  });
});
