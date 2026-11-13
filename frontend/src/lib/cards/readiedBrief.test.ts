import { describe, it, expect } from 'vitest';
import {
  parseReadiedBrief,
  hasBriefContent,
  stripReadiedBrief,
  descriptionSegments,
} from './readiedBrief';

// The real AA intake card description: a fenced project_start_request JSON,
// then the readied_brief wrapped in HTML-comment sentinels.
const INTAKE_DESCRIPTION = [
  '```json',
  '{',
  '  "kind": "project_start_request",',
  '  "github_url": "https://github.com/nonagenticai/n8n_custom_nodes"',
  '}',
  '```',
  '',
  '<!-- aa:readied_brief:start -->',
  '```readied_brief',
  '{ "objective": "do the thing" }',
  '```',
  '<!-- aa:readied_brief:end -->',
].join('\n');

const FULL_BRIEF = {
  objective: 'Implement the X widget',
  context: 'see KAG entry 123',
  principles_applied: [{ id: 'p1', title: 'Fail loud' }],
  requirements_in_scope: [{ id: 'r1', title: 'Must validate input' }],
  decisions: [{ id: 'd1', summary: 'Use postgres' }],
  acceptance_criteria: ['renders', 'passes lint'],
  split_recommendation: null,
  approval_ref: null,
  provenance: { sparse_dimensions: ['Decisions'], assets_authored: ['d1'] },
};

function wrap(json: unknown, label = 'json readied_brief'): string {
  return `Some intro prose.\n\n\`\`\`${label}\n${JSON.stringify(json, null, 2)}\n\`\`\`\n\ntrailing text`;
}

describe('parseReadiedBrief', () => {
  it('parses a full brief from the labelled fence', () => {
    const brief = parseReadiedBrief(wrap(FULL_BRIEF));
    expect(brief).not.toBeNull();
    expect(brief?.objective).toBe('Implement the X widget');
    expect(brief?.principles_applied?.[0]?.id).toBe('p1');
    expect(brief?.acceptance_criteria).toEqual(['renders', 'passes lint']);
  });

  it('returns null for null / empty / whitespace descriptions', () => {
    expect(parseReadiedBrief(null)).toBeNull();
    expect(parseReadiedBrief(undefined)).toBeNull();
    expect(parseReadiedBrief('')).toBeNull();
    expect(parseReadiedBrief('   ')).toBeNull();
  });

  it('returns null when there is no readied_brief fence', () => {
    expect(parseReadiedBrief('Just a plain description.')).toBeNull();
    // A generic json fence without the readied_brief label is ignored.
    expect(parseReadiedBrief('```json\n{"objective":"x"}\n```')).toBeNull();
  });

  it('returns null for a malformed (unparseable) block', () => {
    expect(parseReadiedBrief('```json readied_brief\n{ not valid json,, }\n```')).toBeNull();
  });

  it('returns null when the block is a JSON array or scalar, not an object', () => {
    expect(parseReadiedBrief(wrap([1, 2, 3]))).toBeNull();
    expect(parseReadiedBrief('```json readied_brief\n42\n```')).toBeNull();
  });

  it('tolerates a bare `readied_brief` label without the json hint', () => {
    const brief = parseReadiedBrief(wrap({ objective: 'y' }, 'readied_brief'));
    expect(brief?.objective).toBe('y');
  });

  it('captures only the first labelled block and stops at its closing fence', () => {
    const desc =
      wrap({ objective: 'first' }) + '\n' + wrap({ objective: 'second' });
    expect(parseReadiedBrief(desc)?.objective).toBe('first');
  });
});

describe('stripReadiedBrief', () => {
  it('removes the brief block and keeps surrounding prose', () => {
    const out = stripReadiedBrief(wrap({ objective: 'x' }));
    expect(out).toContain('Some intro prose.');
    expect(out).toContain('trailing text');
    expect(out).not.toContain('objective');
    expect(out).not.toContain('```');
  });

  it('returns the description unchanged (trimmed) when no brief block', () => {
    expect(stripReadiedBrief('  just prose  ')).toBe('just prose');
  });

  it('returns empty string for null/empty', () => {
    expect(stripReadiedBrief(null)).toBe('');
    expect(stripReadiedBrief('')).toBe('');
  });
});

describe('hasBriefContent', () => {
  it('is false for null and for an empty object', () => {
    expect(hasBriefContent(null)).toBe(false);
    expect(hasBriefContent({})).toBe(false);
    expect(hasBriefContent({ acceptance_criteria: [], objective: '   ' })).toBe(
      false,
    );
  });

  it('is true when any field carries content', () => {
    expect(hasBriefContent({ objective: 'do the thing' })).toBe(true);
    expect(hasBriefContent({ principles_applied: [{ id: 'p1' }] })).toBe(true);
    expect(hasBriefContent({ split_recommendation: { needed: true } })).toBe(
      true,
    );
  });
});

describe('stripReadiedBrief — sentinel-wrapped brief', () => {
  it('parses the brief out of the sentinel block', () => {
    expect(parseReadiedBrief(INTAKE_DESCRIPTION)).toEqual({ objective: 'do the thing' });
  });

  it('removes the whole sentinel region — no leftover markers or brief JSON', () => {
    const stripped = stripReadiedBrief(INTAKE_DESCRIPTION);
    expect(stripped).not.toContain('aa:readied_brief');
    expect(stripped).not.toContain('readied_brief');
    expect(stripped).not.toContain('objective');
    // The project_start_request payload survives.
    expect(stripped).toContain('project_start_request');
  });

  it('strips every other aa: marker (opening and closing) but keeps the prose between', () => {
    const desc = [
      'Intro.',
      '<!-- aa:doing_output -->',
      'The DOING handler wrote this.',
      '<!-- /aa:doing_output -->',
      '<!-- aa:qa-result:start sha=abc -->',
    ].join('\n');
    const stripped = stripReadiedBrief(desc);
    expect(stripped).not.toContain('<!--');
    expect(stripped).not.toContain('aa:doing_output');
    expect(stripped).not.toContain('aa:qa-result');
    expect(stripped).toContain('Intro.');
    expect(stripped).toContain('The DOING handler wrote this.');
  });

  it('leaves a non-aa HTML comment alone', () => {
    expect(stripReadiedBrief('a <!-- note --> b')).toBe('a <!-- note --> b');
  });
});

describe('descriptionSegments', () => {
  it('splits a fenced JSON block into a code segment', () => {
    const segs = descriptionSegments(stripReadiedBrief(INTAKE_DESCRIPTION));
    const code = segs.filter((s) => s.type === 'code');
    expect(code).toHaveLength(1);
    expect(code[0].lang).toBe('json');
    expect(code[0].content).toContain('project_start_request');
    expect(code[0].content).not.toContain('```');
  });

  it('keeps plain prose as a single text segment', () => {
    const segs = descriptionSegments('just some notes here');
    expect(segs).toEqual([{ type: 'text', content: 'just some notes here' }]);
  });

  it('interleaves text and code', () => {
    const segs = descriptionSegments('intro\n```sh\nls -la\n```\noutro');
    expect(segs.map((s) => s.type)).toEqual(['text', 'code', 'text']);
    expect(segs[1]).toMatchObject({ type: 'code', lang: 'sh', content: 'ls -la' });
  });

  it('returns [] for empty/nullish', () => {
    expect(descriptionSegments('')).toEqual([]);
    expect(descriptionSegments(null)).toEqual([]);
  });
});
