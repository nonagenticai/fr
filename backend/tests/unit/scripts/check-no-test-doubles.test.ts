// Both polarities of scripts/check-no-test-doubles.ts. Patterns are assembled
// from pieces so this file does not trip the guard it tests.
import { describe, expect, test } from 'bun:test';
import { offences, scan, stripComments } from '../../../scripts/check-no-test-doubles';

const j = (...p: string[]) => p.join('');

describe('check-no-test-doubles', () => {
  test.each([
    ['fetch stub', j('globalThis.', 'fetch = async () => new Response()')],
    ['fetch stub', j('(globalThis as any)', '.fetch = async () => new Response()')],
    ['fetch stub', j('global.', 'fetch = async () => new Response()')],
    ['fetch stub', j('Object.define', "Property(globalThis, 'fetch', { value: f })")],
    ['module mock', j('mock.', "module('../x', () => ({}))")],
    ['module mock', j('vi.', 'mo', "ck('$app/stores')")],
    ['mock function', j('vi.', 'fn()')],
    ['mock function', j('const f = mo', 'ck<typeof send>(async () => 1)')],
    ['mock function', j('const f = mo', 'ck(realSend)')],
    ['spy', j('spy', 'On(db, "select")')],
    ['global stub', j('(Bun as unknown as { RedisClient: unknown })', '.RedisClient = Stub')],
    ['global stub', j('(globalThis as unknown as { setInterval: unknown })', '.setInterval = f')],
    ['fake collaborator', j('class Stub', 'WebSocket {}')],
    ['fake collaborator', j('const db = make', 'FakeDb([])')],
    ['injected fake', j('__set', 'Requirements', 'Deps', 'For', 'Tests({})')],
    ['network interception', j('page.', "route('**/api/**', r => r.abort())")],
    ['prototype patch', j('WebSocket.', 'prototype.send = () => {}')],
    ['fake timers', j('vi.', 'useFake', 'Timers()')],
    ['fake timers', j('vi.', 'setSystem', 'Time(0)')],
    ['fake timers', j('jest.', 'useFake', 'Timers()')],
    ['fake timers', j('setSystem', 'Time(new Date(0))')],
    ['fake server', j('const s = Bun.', 'serve({ port: 0, fetch: () => new Response() })')],
    ['built-in patch', j('Object.', 'entries = () => []')],
    ['built-in patch', j('Array.', 'prototype.', 'map = f')],
    ['built-in patch', j('JSON.', 'parse = f')],
    ['built-in patch', j('Date.', 'now = () => 0')],
    ['built-in patch', j('Math.', 'random = () => 0.5')],
    ['built-in patch', j('globalThis.', 'Object.', 'keys = f')],
    ['built-in patch', j('process.', 'exit = f')],
    ['built-in patch', j('process.', 'env = {}')],
    ['built-in patch', j('Object', '["entries"] = f')],
    ['built-in patch', j('Date.', 'now ||= f')],
    ['built-in patch', j('process.', 'stdout.', 'write = f')],
    ['built-in patch', j('globalThis.', 'process.', 'exit = f')],
  ])('flags %s: %s', (rule, src) => {
    expect(offences('t.test.ts', src)).toContain(`t.test.ts: ${rule}`);
  });

  test('built-in reads, comparisons, process.env.X and process.exitCode writes are not patches', () => {
    const src = j(
      'const e = Object.', 'entries(x);\n',
      'if (Date.', 'now === t) {}\n',
      'process.', 'env.FR_FLAG = "1";\n',
      'process.', 'exitCode = 1;\n',
      'cfg.Object.', 'x = 1;\n',
    );
    expect(offences('t.test.ts', src)).toEqual([]);
  });

  test('ignores comments and console spies', () => {
    expect(offences('t.test.ts', j('// vi.', 'fn()\n/* mock.', 'module( */\n', 'spy', 'On(console, "warn")'))).toEqual([]);
  });

  test('a "/*" inside a string is code, not the start of a comment that swallows the rest', () => {
    const src = j("const glob = '**/*.ts';\n", 'vi.', 'fn();\n', "const end = '*/';\n");
    expect(stripComments(src)).toContain(j('vi.', 'fn()'));
    expect(offences('t.test.ts', src)).toContain('t.test.ts: mock function');
  });

  test('"//" inside a string or regex literal is code too', () => {
    const src = j("const u = 'http://x'; const r = /\\/\\//; ", 'vi.', 'fn();');
    expect(offences('t.test.ts', src)).toContain('t.test.ts: mock function');
  });

  test('a real comment containing a quote does not start a string', () => {
    expect(offences('t.test.ts', j("// don't\nconst a = 1; /* it's */ const b = 2;"))).toEqual([]);
  });

  test('the real tree scans a non-empty scope with no offences', () => {
    const r = scan();
    expect(r.files).toBeGreaterThan(0);
    expect(r.found).toEqual([]);
  });

  test('a missing root is a broken scope, not a pass', () => {
    expect(() => scan(undefined, ['backend/no-such-dir'])).toThrow('scope root missing');
  });
});
