// E-7 + agent-core: dispatcher pipeline with the DEFAULT (null) identity
// resolver — an unknown sender short-circuits to a 200 unknown-sender ack.
// (Cases that installed a stand-in identity resolver and registered synthetic
// actions were removed under the no-test-doubles ruling.)

import { expect, describe } from 'bun:test';
import { dispatchInbound, type InboundMessage } from '../../../src/channels';

import { createDbSuite } from '../helpers/db-suite';


const { itDb } = createDbSuite('dispatcher-pipeline');

describe('agent-core dispatcher pipeline (channel → identity)', () => {
  itDb('null identity resolver short-circuits to unknown-sender (200 ack)', async () => {
    // Default NullIdentityResolver returns null. dispatchInbound must NOT
    // throw and must return a 200 ack with status=unknown-sender per the
    // webhook contract.
    const msg: InboundMessage = {
      channel: 'web',
      userId: 'inbound-placeholder',
      address: 'web-unknown',
      text: 'help',
      correlationId: 'e2e-dispatcher-2',
      raw: {},
    };

    const response = await dispatchInbound(msg);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; correlationId: string };
    expect(body.status).toBe('unknown-sender');
    expect(body.correlationId).toBe('e2e-dispatcher-2');
  });
});
