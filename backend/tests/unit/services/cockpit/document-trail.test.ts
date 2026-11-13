// tests/unit/services/cockpit/document-trail.test.ts
//
// R3 / DOC-3 — the document trail (services/cockpit/document-trail.ts), pure.
//
// MUTATIONS (each turns a case red):
//   · pair by card only (drop the format/window rule)   → "a second report.json is the next version" red;
//   · read the .json instead of the .md                  → "the .md is read, the .json reviewed" red;
//   · fall back to the filename                          → "legacy labels" red;
//   · keep drafts on a finished project                  → "drafts hidden when finished" red;
//   · list an empty phase                                → "only what was produced" red.
import { describe, expect, test } from 'bun:test';

import {
  PAIR_WINDOW_MS,
  composeDocumentTrail,
  fallbackTitle,
  kindLabel,
  pairVersions,
  type TrailArtifact,
  type TrailInputs,
} from '../../../../src/services/cockpit/document-trail';

const P = '0ad49b9c-5a67-4a26-9fe6-8d24dc61779e';
let seq = 0;
function art(over: Partial<TrailArtifact> & { at: string }): TrailArtifact {
  seq += 1;
  const { at, ...rest } = over;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    version: 1,
    filename: 'report.json',
    content_type: 'application/json',
    kind: 'json',
    project_id: P,
    sensitivity: 'internal',
    size: 10,
    sha256: 'x',
    storage_key: 'k',
    created_at: at,
    created_by: 'conveyor',
    tags: [],
    status: 'pending',
    publish_status: 'draft',
    ...rest,
  } as TrailArtifact;
}

const PHASES = [
  { name: 'setup', label: 'Setup', state: 'done' },
  { name: 'preliminary', label: 'Preliminary', state: 'done' },
  { name: 'execution', label: 'Execution', state: 'active' },
  { name: 'closure', label: 'Closure', state: 'upcoming' },
];

function inputs(over: Partial<TrailInputs>): TrailInputs {
  return {
    artifacts: [],
    phases: PHASES,
    currentPhase: 'execution',
    cardPhase: new Map([
      ['c-analysis', 'preliminary'],
      ['c-dev', 'execution'],
      ['c-close', 'closure'],
    ]),
    cardNames: new Map([
      ['c-analysis', 'Gap analysis'],
      ['c-dev', 'Implement low-stock report'],
      ['c-close', 'Project closure'],
    ]),
    pullRequests: null,
    finished: false,
    ...over,
  };
}

describe('pairing: a report.json and its document.md from the same card are ONE document', () => {
  test('json + md uploaded together → one document, one version; the .md is read, the .json reviewed', () => {
    const json = art({ at: '2026-10-27T10:00:00Z', planka_card_id: 'c-dev', doc_type: 'development_report', review_callback_url: 'https://n8n/webhook/x' });
    const md = art({
      at: '2026-10-27T10:00:04Z',
      planka_card_id: 'c-dev',
      doc_type: 'development_report',
      filename: 'document.md',
      content_type: 'text/markdown',
      kind: 'doc',
      title: 'Low-stock report delivered',
      summary: 'The report lists 3 items under threshold.',
    });
    const t = composeDocumentTrail(inputs({ artifacts: [json, md] }));
    const docs = t.phases.flatMap((p) => p.documents);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      artifact_id: md.id,
      review_artifact_id: json.id,
      title: 'Low-stock report delivered',
      type_label: 'Development report',
      summary: 'The report lists 3 items under threshold.',
      version: 1,
      version_count: 1,
      phase: 'execution',
      reviewable: true,
    });
  });

  test('pairing uses the card tag when planka_card_id is NULL (legacy rows)', () => {
    const json = art({ at: '2026-10-27T10:00:00Z', tags: ['planka_card:c-dev'] });
    const md = art({ at: '2026-10-27T10:01:00Z', tags: ['planka_card:c-dev'], filename: 'document.md', content_type: 'text/markdown' });
    const docs = composeDocumentTrail(inputs({ artifacts: [md, json] })).phases.flatMap((p) => p.documents);
    expect(docs.map((d) => d.artifact_id)).toEqual([md.id]);
  });

  test('a re-run of the card (a second report.json) is the NEXT version of the same document, newest shown', () => {
    const v1 = art({ at: '2026-10-25T08:07:38Z', planka_card_id: 'c-dev' });
    const v2 = art({ at: '2026-10-25T08:09:43Z', planka_card_id: 'c-dev', publish_status: 'published' });
    const docs = composeDocumentTrail(inputs({ artifacts: [v1, v2] })).phases.flatMap((p) => p.documents);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.artifact_id).toBe(v2.id);
    expect(docs[0]!.version).toBe(2);
    expect(docs[0]!.status).toBe('published');
    expect(docs[0]!.versions.map((v) => [v.number, v.artifact_id])).toEqual([
      [2, v2.id],
      [1, v1.id],
    ]);
  });

  test('a .md uploaded outside the window is not paired; a different doc_type on the same card is another document', () => {
    const a = art({ at: '2026-10-27T10:00:00Z', planka_card_id: 'c-dev', doc_type: 'development_report' });
    const late = art({
      at: new Date(Date.parse('2026-10-27T10:00:00Z') + PAIR_WINDOW_MS + 1000).toISOString(),
      planka_card_id: 'c-dev',
      doc_type: 'development_report',
      filename: 'document.md',
      content_type: 'text/markdown',
    });
    expect(pairVersions([a, late])).toHaveLength(2);
    const other = art({ at: '2026-10-27T10:00:01Z', planka_card_id: 'c-dev', doc_type: 'qa_report' });
    const docs = composeDocumentTrail(inputs({ artifacts: [a, other] })).phases.flatMap((p) => p.documents);
    expect(docs).toHaveLength(2);
  });

  test('artifacts with no card are never paired with each other', () => {
    const x = art({ at: '2026-10-27T10:00:00Z' });
    const y = art({ at: '2026-10-27T10:00:01Z', filename: 'document.md', content_type: 'text/markdown' });
    const t = composeDocumentTrail(inputs({ artifacts: [x, y] }));
    expect(t.unassigned.documents).toHaveLength(2);
  });
});

describe('legacy labels: never a file name or id', () => {
  test('no title: "<kind>: <card name>"; no card name: the kind', () => {
    const withCard = art({ at: '2026-10-25T08:00:00Z', tags: ['planka_card:c-analysis'] });
    const unknownCard = art({ at: '2026-10-25T08:01:00Z', tags: ['planka_card:c-gone'] });
    const csv = art({ at: '2026-10-25T08:02:00Z', filename: 'stock_levels_2026.csv', content_type: 'text/csv', kind: 'dataset' });
    const t = composeDocumentTrail(inputs({ artifacts: [withCard, unknownCard, csv] }));
    const all = [...t.phases.flatMap((p) => p.documents), ...t.unassigned.documents];
    const titles = all.map((d) => d.title).sort();
    expect(titles).toEqual(['Dataset', 'Report', 'Report: Gap analysis']);
    for (const d of all) {
      expect(d.title).not.toContain('.json');
      expect(d.title).not.toContain('.csv');
      expect(d.title).not.toContain(d.artifact_id);
    }
  });

  test('doc_type words the kind; document files read as "Document"', () => {
    expect(kindLabel({ doc_type: 'gap_analysis_report', filename: 'report.json', kind: 'json' })).toBe('Gap analysis report');
    expect(kindLabel({ doc_type: null, filename: 'document.md', kind: 'doc' })).toBe('Document');
    expect(fallbackTitle({ doc_type: null, filename: 'report.json', kind: 'json' }, 'Project closure')).toBe('Report: Project closure');
  });
});

describe('finished project: drafts are hidden, the final report is on top', () => {
  test('a finished project lists published documents only, and their draft versions are gone too', () => {
    const draftOnly = art({ at: '2026-10-25T07:50:00Z', tags: ['planka_card:c-analysis'] });
    const v1 = art({ at: '2026-10-25T08:07:38Z', tags: ['planka_card:c-dev'] });
    const v2 = art({ at: '2026-10-25T08:09:43Z', tags: ['planka_card:c-dev'], publish_status: 'published' });
    const close = art({ at: '2026-10-25T08:50:33Z', tags: ['planka_card:c-close'], publish_status: 'published' });
    const t = composeDocumentTrail(inputs({ artifacts: [draftOnly, v1, v2, close], finished: true, currentPhase: 'closure' }));
    expect(t.final_report).toMatchObject({ artifact_id: close.id, is_final: true, phase: 'closure', reviewable: false });
    const docs = t.phases.flatMap((p) => p.documents);
    expect(docs.map((d) => d.artifact_id)).toEqual([v2.id]);
    expect(docs[0]!.versions.map((v) => v.artifact_id)).toEqual([v2.id]);
    expect(docs[0]!.reviewable).toBe(false);
    // The final report is not repeated in its phase; an emptied phase is absent (§8).
    expect(t.phases.map((p) => p.name)).toEqual(['execution']);
  });

  test('while running, drafts show, nothing is the final report until Closure publishes one', () => {
    const d = art({ at: '2026-10-25T08:07:38Z', tags: ['planka_card:c-dev'] });
    const pub = art({ at: '2026-10-25T08:00:00Z', tags: ['planka_card:c-analysis'], publish_status: 'published' });
    const t = composeDocumentTrail(inputs({ artifacts: [d, pub] }));
    expect(t.final_report).toBeNull();
    expect(t.phases.map((p) => [p.name, p.current, p.documents.map((x) => x.status)])).toEqual([
      ['execution', true, ['draft']],
      ['preliminary', false, ['published']],
    ]);
  });

  test('newest first within a phase; a needs_revision document reads "in review"', () => {
    const a = art({ at: '2026-10-25T08:00:00Z', tags: ['planka_card:c-dev'], doc_type: 'a' });
    const b = art({ at: '2026-10-25T09:00:00Z', tags: ['planka_card:c-dev'], doc_type: 'b', status: 'needs_revision' });
    const docs = composeDocumentTrail(inputs({ artifacts: [a, b] })).phases[0]!.documents;
    expect(docs.map((x) => [x.artifact_id, x.status])).toEqual([
      [b.id, 'in_review'],
      [a.id, 'draft'],
    ]);
  });
});

describe('pull requests sit in their card\'s phase', () => {
  test('a PR on an execution card is listed under Execution; one on an unknown card is unassigned', () => {
    const pr = (card: string, n: number) => ({
      url: `https://github.com/o/r/pull/${n}`,
      repo: 'o/r',
      number: n,
      branch: null,
      head_sha: null,
      card_id: card,
      card_name: 'x',
      first_seen_at: '2026-10-25T09:00:00Z',
      state: 'merged' as const,
      title: 'Low stock',
      state_unavailable: null,
    });
    const t = composeDocumentTrail(inputs({ pullRequests: [pr('c-dev', 12), pr('c-gone', 13)] }));
    expect(t.phases.map((p) => [p.name, p.pull_requests.map((r) => r.title)])).toEqual([['execution', ['PR #12 · Low stock']]]);
    expect(t.unassigned.pull_requests.map((r) => r.title)).toEqual(['PR #13 · Low stock']);
  });
});
