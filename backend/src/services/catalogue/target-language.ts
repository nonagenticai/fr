// services/catalogue/target-language.ts
//
// The target language of a language rewrite is EXTRACTED FROM THE PROJECT REQUEST
// at create (George 2026-11-07: "target language should be extracted from the project
// request … and get processed into the project brief"). The form no longer asks for
// it, so this is the only producer for a rewrite created from the form.
//
// It is one single-turn worker call — the same `intake_project_brief_extraction`
// worker `routes/project-requests.ts` already uses for NL→brief extraction, with a
// CLOSED output schema (additionalProperties: false), so a language the request does
// not state is never invented. The value is written to `brief.target_language`
// (George 2026-11-07 — "processed into the project brief"), which is where the four
// live rewrite flows read it (`Rewrite inputs` in each `.READY` workflow); RM still
// refuses a rewrite without it (422 `rewrite_needs_language`), which this module
// satisfies before RM is called.
//
// ⛔ No test doubles (owner ruling 2026-10-29): the pure parts below are unit tested;
// the worker round-trip is verified live.

import { sendWorkerMessage } from '../../integrations/workers';
import { RewriteLanguageSchema } from '../../types/api';
import { AppError } from '../../utils/errors';

const WORKER_NAME = 'intake_project_brief_extraction';

/** The closed extraction schema: one optional enum value, nothing else. */
export const TARGET_LANGUAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target_language: {
      type: 'string',
      enum: ['python', 'rust'],
      description:
        'The TARGET language the request asks to rewrite or port code INTO. Omit when the ' +
        'request does not name one — never guess.',
    },
  },
} as const;

export const TARGET_LANGUAGE_PROMPT = [
  'You read a software project request and return the TARGET programming language ONLY when',
  'the request asks to rewrite or port code into another language.',
  'Return at most one of "rust" or "python".',
  'Never guess: if the request does not name the target language, return an empty object.',
  'Do not add commentary; emit only the structured object.',
].join(' ');

/**
 * The free text a person wrote for this project: the name, the description and every
 * brief field fr receives on the create body. Anything absent is skipped, so an empty
 * request stays empty (and the extraction returns nothing rather than inventing).
 */
const REQUEST_TEXT_FIELDS = [
  'name',
  'description',
  'problem_statement',
  'desired_outcome',
  'business_case',
  'high_level_requirements',
  'in_scope',
  'out_of_scope',
  'acceptance_criteria',
  'success_criteria',
  'assumptions',
  'notes',
] as const;

export function requestTextOf(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of REQUEST_TEXT_FIELDS) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) parts.push(`${key}: ${value.trim()}`);
    else if (Array.isArray(value)) {
      const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (items.length) parts.push(`${key}: ${items.map((v) => v.trim()).join('; ')}`);
    }
  }
  return parts.join('\n');
}

/** Only a rewrite that does not already carry a language needs the extraction. */
export function needsTargetLanguage(body: {
  it_flow?: string;
  target_language?: string;
}): boolean {
  return body.it_flow === 'rewrite' && !body.target_language;
}

/** The worker's answer as a language, or null — an off-vocabulary value is NOT guessed. */
export function targetLanguageFromOutput(output: unknown): 'python' | 'rust' | null {
  const raw = (output as Record<string, unknown> | null | undefined)?.['target_language'];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  const parsed = RewriteLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * One single-turn worker call. A worker outage is a 503 (retryable), never a silent
 * "no language": the caller would otherwise get RM's jargon 422 for a request that
 * may well have named the language.
 */
export async function extractTargetLanguage(text: string): Promise<'python' | 'rust' | null> {
  let output: unknown;
  try {
    const res = await sendWorkerMessage(WORKER_NAME, {
      message: text,
      system_prompt: TARGET_LANGUAGE_PROMPT,
      output_schema: TARGET_LANGUAGE_OUTPUT_SCHEMA,
      // Ephemeral: a stateless extract must not persist worker state.
      disable_state_storage: true,
    });
    output = res.output;
  } catch (err) {
    throw new AppError(
      503,
      `the target language could not be read from the project request (${err instanceof Error ? err.name : 'worker error'})`,
    ).withCode('target_language_extraction_unavailable');
  }
  return targetLanguageFromOutput(output);
}
