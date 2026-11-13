import { test, expect, describe } from 'bun:test';
import { PlankaClient, PlankaAuth, PlankaHttp, type PlankaAuthConfig } from '../../../../src/services/planka';

const authCfg: PlankaAuthConfig = {
  baseUrl: 'http://p',
  email: 'a',
  password: 'p',
  termsPath: '/api/terms',
  acceptTermsPath: '/api/access-tokens/accept-terms',
  defaultLanguage: 'en-US',
};

describe('PlankaClient', () => {
  test('forTesting wires all resource namespaces', () => {
    const auth = new PlankaAuth(authCfg);
    const http = new PlankaHttp(auth, 'http://p');
    const client = PlankaClient.forTesting(http, auth);
    expect(client.projects).toBeDefined();
    expect(client.boards).toBeDefined();
    expect(client.lists).toBeDefined();
    expect(client.cards).toBeDefined();
    expect(client.comments).toBeDefined();
    expect(client.labels).toBeDefined();
    expect(client.tasks).toBeDefined();
    expect(client.taskLists).toBeDefined();
    expect(client.members).toBeDefined();
    expect(client.http).toBe(http);
    expect(client.auth).toBe(auth);
  });

  test('asAgent returns a new client on the same transport and token cache', () => {
    const auth = new PlankaAuth(authCfg);
    const http = new PlankaHttp(auth, 'http://p');
    const root = PlankaClient.forTesting(http, auth);
    const agent = root.asAgent();
    expect(agent).not.toBe(root);
    expect(agent.http).toBe(http); // shared
    expect(agent.auth).toBe(auth); // shared
    expect(agent.projects).not.toBe(root.projects); // fresh resource namespaces
  });

  test('has no per-user client: Planka use is per tenant, one configured account', () => {
    const auth = new PlankaAuth(authCfg);
    const client = PlankaClient.forTesting(new PlankaHttp(auth, 'http://p'), auth);
    expect((client as unknown as Record<string, unknown>).asUser).toBeUndefined();
  });
});
