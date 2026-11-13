import { describe, test, expect } from 'bun:test';
import {
  CredentialTypeEnum,
  CredentialsSchema,
  BasicAuthCredentialsSchema,
  FormAuthCredentialsSchema,
} from '../../../src/types/urlCredentials';

describe('CredentialTypeEnum', () => {
  test('includes form', () => {
    expect(CredentialTypeEnum.parse('form')).toBe('form');
  });

  test('includes basic, bearer, api_key, cookie, custom, form', () => {
    const types = ['basic', 'bearer', 'api_key', 'cookie', 'custom', 'form'] as const;
    for (const t of types) {
      expect(CredentialTypeEnum.parse(t)).toBe(t);
    }
  });

  test('rejects unknown auth_type', () => {
    expect(() => CredentialTypeEnum.parse('not-a-type')).toThrow();
  });
});

describe('FormAuthCredentialsSchema', () => {
  test('accepts minimal { auth_type: "form", username, password }', () => {
    const r = FormAuthCredentialsSchema.parse({
      auth_type: 'form',
      username: 'u',
      password: 'p',
    });
    expect(r.auth_type).toBe('form');
    expect(r.username).toBe('u');
    expect(r.password).toBe('p');
  });

  test('rejects empty username', () => {
    expect(() =>
      FormAuthCredentialsSchema.parse({ auth_type: 'form', username: '', password: 'p' }),
    ).toThrow();
  });

  test('rejects empty password', () => {
    expect(() =>
      FormAuthCredentialsSchema.parse({ auth_type: 'form', username: 'u', password: '' }),
    ).toThrow();
  });

  test('rejects wrong auth_type literal', () => {
    expect(() =>
      FormAuthCredentialsSchema.parse({ auth_type: 'basic', username: 'u', password: 'p' }),
    ).toThrow();
  });
});

describe('CredentialsSchema discriminated union', () => {
  test('routes form auth_type through FormAuthCredentialsSchema', () => {
    const r = CredentialsSchema.parse({
      auth_type: 'form',
      username: 'u',
      password: 'p',
    });
    expect(r.auth_type).toBe('form');
    if (r.auth_type === 'form') {
      expect(r.username).toBe('u');
      expect(r.password).toBe('p');
    }
  });

  test('still routes basic auth_type through BasicAuthCredentialsSchema', () => {
    const r = CredentialsSchema.parse({
      auth_type: 'basic',
      username: 'u',
      password: 'p',
    });
    expect(r.auth_type).toBe('basic');
    if (r.auth_type === 'basic') {
      expect(BasicAuthCredentialsSchema.parse(r)).toEqual(r);
    }
  });

  test('rejects form variant missing password', () => {
    expect(() =>
      CredentialsSchema.parse({ auth_type: 'form', username: 'u' }),
    ).toThrow();
  });
});
