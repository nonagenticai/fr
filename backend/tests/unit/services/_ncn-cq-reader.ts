// tests/unit/services/_ncn-cq-reader.ts — TEST HELPER, not a test file.
//
// A faithful copy of ncn's QA scenario reader, so fr's freeze can be checked
// against what ncn will actually READ (consumer parity).
//
// SOURCE: n8n_custom_nodes origin/main (45ca15b96, 2026-10-03)
//   scripts/lib/coding-qa-verdict.mjs — functions AA_CQ_SCENARIOS (L75-92),
//   AA_CQ_SHA256 (L96-114), AA_CQ_HASH (L119-126), AA_CQ_HASH_STATE (L129-133).
// Copied character-for-character except: TypeScript `any` annotations and `!`
// index assertions, `catch (e)` → bare `catch` (unused binding), and
// AA_CQ_SCENARIOS keeps only the lines that compute `known`, `set` and
// `stored_hash` (its `scn` / `crits` / `why` / slug fallback are not read by
// AA_CQ_HASH_STATE and are omitted).
//
// ⛔ RE-SYNC THIS FILE whenever coding-qa-verdict.mjs changes those functions:
// a stale copy makes the parity test assert against a reader ncn no longer runs.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function AA_CQ_SCENARIOS(desc: any, validation?: any): { known: boolean; set: any[]; stored_hash: string | null } {
  const t = String(desc || ''), V = (validation && typeof validation === 'object') ? validation : {};
  const P = (x: any) => { try { const o = JSON.parse(x); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch { return null; } };
  const D: any = P(t.split('<!-- aa:readied_brief:start -->')[0]!.trim()) || {}, F = /```readied_brief\s*([\s\S]*?)```/.exec(t), B: any = F ? P(F[1]) : null;
  const has = (o: any) => !!o && Array.isArray(o.gherkin_scenarios) && o.gherkin_scenarios.length > 0;
  const src = has(B) ? B : has(D) ? D : null, known = !(F && !B && !src);
  const sc = (B && B.scenarios_check && typeof B.scenarios_check === 'object') ? B.scenarios_check : (D.scenarios_check && typeof D.scenarios_check === 'object') ? D.scenarios_check : {};
  const set = (src ? src.gherkin_scenarios : []).filter((s: any) => s && /^scn_[0-9a-f]{8}$/.test(s.scenario_id) && /^crit_[0-9a-f]{8}$/.test(s.criterion_id));
  return { known, set, stored_hash: (typeof sc.scenario_hash === 'string' && sc.scenario_hash) || (typeof V.scenario_hash === 'string' && V.scenario_hash) || null };
}

export function AA_CQ_SHA256(str: any): string {
  const u = unescape(encodeURIComponent(String(str))), b: number[] = [], H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const R = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < u.length; i++) { b.push(u.charCodeAt(i)); }
  const bits = u.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) { b.push(0); }
  b.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
  for (let o = 0; o < b.length; o += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) { w.push((b[o + 4 * i]! << 24) | (b[o + 4 * i + 1]! << 16) | (b[o + 4 * i + 2]! << 8) | b[o + 4 * i + 3]!); }
    for (let i = 16; i < 64; i++) { w.push((w[i - 16]! + (R(w[i - 15]!, 7) ^ R(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) + w[i - 7]! + (R(w[i - 2]!, 17) ^ R(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10))) | 0); }
    let a = H[0]!, c1 = H[1]!, c2 = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) { const t1 = (h + (R(e, 6) ^ R(e, 11) ^ R(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0, t2 = ((R(a, 2) ^ R(a, 13) ^ R(a, 22)) + ((a & c1) ^ (a & c2) ^ (c1 & c2))) | 0; h = g; g = f; f = e; e = (d + t1) | 0; d = c2; c2 = c1; c1 = a; a = (t1 + t2) | 0; }
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + c1) | 0; H[2] = (H[2]! + c2) | 0; H[3] = (H[3]! + d) | 0; H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function AA_CQ_HASH(scenarios: any): string {
  const N = (g: any) => { if (g === null || g === undefined) { return null; } if (typeof g !== 'string') { throw new Error('gherkin must be string|null'); } const L = String(g).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')); while (L.length && L[L.length - 1] === '') { L.pop(); } return L.length ? L.join('\n') + '\n' : null; };
  if (!Array.isArray(scenarios)) { throw new Error('scenarios must be an array'); }
  const p = Array.from(scenarios).map((s: any) => ({ scenario_id: String(s.scenario_id), criterion_id: String(s.criterion_id), title: String(s.title ?? ''), gherkin: N(s.gherkin) }));
  p.sort((a, b) => (a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0));
  for (let i = 1; i < p.length; i++) { if (p[i]!.scenario_id === p[i - 1]!.scenario_id) { throw new Error('duplicate scenario_id ' + p[i]!.scenario_id); } }
  return AA_CQ_SHA256('[' + p.map((o) => '{"criterion_id":' + JSON.stringify(o.criterion_id) + ',"gherkin":' + JSON.stringify(o.gherkin) + ',"scenario_id":' + JSON.stringify(o.scenario_id) + ',"title":' + JSON.stringify(o.title) + '}').join(',') + ']');
}

export function AA_CQ_HASH_STATE(C: any): 'ok' | 'missing' | 'mismatch' | null {
  if (!C || !Array.isArray(C.set) || !C.set.length) { return null; }
  if (!C.stored_hash) { return 'missing'; }
  try { return AA_CQ_HASH(C.set) === C.stored_hash ? 'ok' : 'mismatch'; } catch { return 'mismatch'; }
}
