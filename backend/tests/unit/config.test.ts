import { test, expect } from "bun:test";
import { validateProductionConfig } from "../../src/config";

// ---------------------------------------------------------------------------
// PLATFORM_BUDGET_WEBHOOK_SECRET is a boot-time requirement in production.
//
// It was missing from validateProductionConfig's required list while the
// budget-threshold receiver treated an empty value as "skip signature
// verification". Together those two facts meant blanking or rotating the var
// silently turned /api/webhooks/billing/budget-threshold into an
// unauthenticated endpoint — no crash, no 401, just 200s. The receiver now
// fails closed; this check makes the misconfiguration fail at BOOT instead.
//
// The fixture is a fully-populated production config so the assertion is
// SELECTIVE: the only thing wrong with `cfg` is the empty billing secret, which
// is what makes a failure here mean what it says.
// ---------------------------------------------------------------------------

function fullProdCfg(): {
  env: string;
  keycloak: { url: string };
  services: Record<string, unknown>;
} {
  return {
    env: "production",
    keycloak: { url: "http://kc.example.test" },
    services: {
      n8n: {
        webhookSecret: "shh",
        webhookUrl: "http://n8n/webhook",
        apiUrl: "http://n8n/api",
        approvalCallbackSecret: "callback-shh",
      },
      teams: { callbackUrl: "http://fr/api/webhooks/teams" },
      planka: { baseUrl: "http://planka" },
      workers: { baseUrl: "http://workers" },
      requirements: { baseUrl: "http://requirements" },
      kanban: { baseUrl: "http://planka/api" },
      codingGateway: "http://coding-gateway",
      secrets: { baseUrl: "http://secrets" },
      artifacts: { baseUrl: "http://artifacts", downloadSigningKey: "shh" },
      billing: { baseUrl: "http://billing", budgetWebhookSecret: "budget-shh" },
      licenses: { baseUrl: "http://licenses" },
      prometheus: { baseUrl: "http://prometheus" },
      pushgateway: { baseUrl: "http://pushgateway" },
      grafana: { baseUrl: "https://grafana.nonagentic.ai" },
    },
  };
}

test("production + empty billing.budgetWebhookSecret → throws (PLATFORM_BUDGET_WEBHOOK_SECRET in error)", () => {
  // AUTH_BYPASS must be cleared: `validateProductionConfig` refuses to boot
  // when it is set on a production-shaped deploy, and CI runs this suite with
  // AUTH_BYPASS=true (tests/setup.ts preload). Left set, the control below throws on the
  // bypass guard instead of passing, and this test would report a missing
  // webhook secret when the real objection was something else entirely.
  const savedAuthBypass = process.env.AUTH_BYPASS;
  delete process.env.AUTH_BYPASS;
  try {
  // Control: the fixture is otherwise complete and must NOT throw. Without
  // this the test below could pass for any unrelated missing var.
  expect(() => validateProductionConfig(fullProdCfg())).not.toThrow();

  const cfg = fullProdCfg();
  (cfg.services.billing as { budgetWebhookSecret: string }).budgetWebhookSecret = "";
  expect(() => validateProductionConfig(cfg)).toThrow(/PLATFORM_BUDGET_WEBHOOK_SECRET/);
  } finally {
    if (savedAuthBypass === undefined) delete process.env.AUTH_BYPASS;
    else process.env.AUTH_BYPASS = savedAuthBypass;
  }
});

// improvement-loop-service and the KAG family were removed from the cluster
// (gitops #4968). fr must boot WITHOUT METERING_* and KAG_* — the fixture above
// carries neither — while billing (BILLING_BASE_URL) is still required.
test("production without kag/metering boots; empty billing.baseUrl → throws (BILLING_BASE_URL in error)", () => {
  const savedAuthBypass = process.env.AUTH_BYPASS;
  delete process.env.AUTH_BYPASS;
  try {
    const ok = fullProdCfg();
    expect(ok.services.kag).toBeUndefined();
    expect(ok.services.metering).toBeUndefined();
    expect(() => validateProductionConfig(ok)).not.toThrow();

    const cfg = fullProdCfg();
    (cfg.services.billing as { baseUrl: string }).baseUrl = "";
    expect(() => validateProductionConfig(cfg)).toThrow(/BILLING_BASE_URL/);
    expect(() => validateProductionConfig(cfg)).not.toThrow(/KAG_|METERING_/);
  } finally {
    if (savedAuthBypass === undefined) delete process.env.AUTH_BYPASS;
    else process.env.AUTH_BYPASS = savedAuthBypass;
  }
});
