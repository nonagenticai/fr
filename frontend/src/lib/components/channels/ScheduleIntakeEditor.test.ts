// @vitest-environment jsdom
//
// Spec 2 §2-B / Plan 2-C Phase 2 — ScheduleIntakeEditor component tests.
//
// Verifies the editor's wire shape matches backend `CreateBodySchema.strict()`
// in routes/scheduled-triggers.ts: required fields with no backend default
// (card_template, payload_mapper) must be present after default-fill, and
// fields with backend defaults (timezone='UTC', target_list='INBOX',
// enabled=true) must appear with those defaults.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ScheduleIntakeEditor from './ScheduleIntakeEditor.svelte';
import type { ScheduledTriggerCreate } from '$lib/types/api';

const PROJECT_ID = '00000000-0000-7000-8000-000000000001';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host.remove();
});

describe('ScheduleIntakeEditor', () => {
  it('default-fills the wire body with backend-required fields', async () => {
    const value: Partial<ScheduledTriggerCreate> = {};
    app = mount(ScheduleIntakeEditor, {
      target: host,
      props: { value, projectId: PROJECT_ID, mode: 'create' },
    });
    flushSync();
    await tick();

    expect(value.project_id).toBe(PROJECT_ID);
    // cron starts blank — operator must fill it.
    expect(value.cron).toBe('');
    // Backend defaults are surfaced in the body so the wire shape is
    // explicit, not implicit.
    expect(value.timezone).toBe('UTC');
    expect(value.target_list).toBe('INBOX');
    expect(value.enabled).toBe(true);
    // Required-no-default fields must be present after fill.
    expect(value.payload_mapper).toEqual({});
    expect(value.card_template).toBeDefined();
    expect(value.card_template?.card_type).toBe('work_intake_record');
    // source_connector + connector_config seeded.
    expect(value.source_connector).toBe('rss');
    expect(value.connector_config).toBeDefined();
  });

  // H1: the file connector read the fr-backend pod's filesystem and the
  // backend refuses it; the kind picker must not offer it.
  it('the connector kind picker does not offer file', async () => {
    const value: Partial<ScheduledTriggerCreate> = {};
    app = mount(ScheduleIntakeEditor, {
      target: host,
      props: { value, projectId: PROJECT_ID, mode: 'create' },
    });
    flushSync();
    await tick();

    const select = host.querySelector<HTMLSelectElement>('[data-testid="connector-kind"]');
    const kinds = Array.from(select?.options ?? []).map((o) => o.value);
    expect(kinds).toEqual(['rss', 'github_query', 's3', 'n8n_webhook']);
  });

  it('validate() returns false when name is empty', async () => {
    const value: Partial<ScheduledTriggerCreate> = {};
    app = mount(ScheduleIntakeEditor, {
      target: host,
      props: { value, projectId: PROJECT_ID, mode: 'create' },
    });
    flushSync();
    await tick();

    const component = app as unknown as { validate: () => boolean };
    // No name, no cron → false.
    expect(component.validate()).toBe(false);
  });

  it('validate() returns true with name + cron + minimum valid connector + mapper', async () => {
    const value: Partial<ScheduledTriggerCreate> = {
      name: 'My Feed',
      cron: '*/5 * * * *',
      source_connector: 'rss',
      // Pre-fill a valid RSS connector_config so RssConnectorForm.validate() passes.
      connector_config: {
        kind: 'rss',
        secret_id: null,
        feed_url: 'https://example.com/feed.xml',
        max_items: 50,
      },
      // Provide a valid mapper row so MapperEditor.validate() passes.
      payload_mapper: { card_title: '$.title' },
    };
    app = mount(ScheduleIntakeEditor, {
      target: host,
      props: { value, projectId: PROJECT_ID, mode: 'create' },
    });
    flushSync();
    await tick();

    const component = app as unknown as { validate: () => boolean };
    expect(component.validate()).toBe(true);
  });

  it('does not overwrite caller-provided non-empty fields', async () => {
    const value: Partial<ScheduledTriggerCreate> = {
      name: 'preset',
      cron: '0 * * * *',
      timezone: 'Europe/Amsterdam',
      target_list: 'TRIAGE',
      payload_mapper: { card_title: '$.headline' },
      enabled: false,
      card_template: {
        card_type: 'work_intake_record',
        labels: ['inbound'],
      },
    };
    app = mount(ScheduleIntakeEditor, {
      target: host,
      props: { value, projectId: PROJECT_ID, mode: 'edit' },
    });
    flushSync();
    await tick();

    expect(value.name).toBe('preset');
    expect(value.cron).toBe('0 * * * *');
    expect(value.timezone).toBe('Europe/Amsterdam');
    expect(value.target_list).toBe('TRIAGE');
    expect(value.payload_mapper).toEqual({ card_title: '$.headline' });
    expect(value.enabled).toBe(false);
    expect(value.card_template?.labels).toEqual(['inbound']);
  });
});
