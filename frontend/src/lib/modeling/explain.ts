// Plain-language wording for the modeling pages.
//
// ⛔ These functions EXPLAIN what requirements_management stored; they never
// decide anything. A run is "clean" because RM's `clean` flag says so, a change
// set can be applied because RM's `status` is `proposed` — fr only puts the
// stored verdict into words a user can act on (fr is a facilitator, never a
// judge).

import type { ChangeOpView as ChangeOp, ChangeSet, ChangeSetStatus, ExchangeLoss, Severity, ValidationRun } from '$lib/api/modeling';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface Verdict {
  tone: Tone;
  label: string;
  explanation: string;
}

/** "1 relationship", "2 relationships", "0 relationships". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The stored verdict of a validation run, in words. */
export function runVerdict(run: Pick<ValidationRun, 'status' | 'clean' | 'counts' | 'examined' | 'expected'>): Verdict {
  const errors = run.counts?.error ?? 0;
  if (run.status === 'failed') {
    return {
      tone: 'danger',
      label: 'Could not finish',
      explanation: 'The check stopped before it finished, so its results cannot be relied on. Run it again.',
    };
  }
  if (run.status === 'incomplete') {
    const examined = Object.values(run.examined ?? {}).reduce((a, b) => a + b, 0);
    const expected = Object.values(run.expected ?? {}).reduce((a, b) => a + b, 0);
    const part = expected > 0 ? ` It looked at ${examined} of ${expected === 1 ? '1 item' : `${expected} items`}.` : '';
    return {
      tone: 'warning',
      label: 'Incomplete',
      explanation: `Some of the model could not be checked, so the results are partial and do not count for publishing.${part}`,
    };
  }
  if (run.clean) {
    return {
      tone: 'success',
      label: 'Clean',
      explanation: 'Every required rule ran and no errors were found. Any warnings or advice listed are suggestions, not blockers.',
    };
  }
  if (errors > 0) {
    return {
      tone: 'danger',
      label: plural(errors, 'error'),
      explanation: `The check found ${plural(errors, 'error')}. A version with errors cannot be published until they are fixed and the check is run again.`,
    };
  }
  return {
    tone: 'warning',
    label: 'Not clean',
    explanation: 'No errors were found, but some required rules were switched off for this check, so it does not count for publishing.',
  };
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  advice: 'Advice',
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  error: 'danger',
  warning: 'warning',
  advice: 'neutral',
};

export const SEVERITY_HELP: Record<Severity, string> = {
  error: 'Breaks a modeling rule. Must be fixed before publishing.',
  warning: 'Probably a mistake. Worth checking.',
  advice: 'A suggestion to make the model clearer.',
};

export const CHANGE_SET_STATUS: Record<ChangeSetStatus, Verdict> = {
  proposed: { tone: 'accent', label: 'Ready to apply', explanation: 'These changes have not been made yet. Apply them to update the model, or reject them.' },
  invalid: {
    tone: 'danger',
    label: 'Cannot be applied',
    explanation: 'These changes would break the model, so they cannot be applied. See the problems below; fix the source file and import it again.',
  },
  applied: { tone: 'success', label: 'Applied', explanation: 'These changes are now part of the model.' },
  rejected: { tone: 'neutral', label: 'Rejected', explanation: 'These changes were turned down and will not be applied.' },
};

export function changeSetStatus(status: string): Verdict {
  return CHANGE_SET_STATUS[status as ChangeSetStatus] ?? { tone: 'neutral', label: status, explanation: '' };
}

const KIND_NOUN: Record<string, [string, string]> = {
  element: ['element', 'elements'],
  relationship: ['relationship', 'relationships'],
  view: ['view', 'views'],
  view_object: ['diagram shape', 'diagram shapes'],
  view_connection: ['diagram line', 'diagram lines'],
  organization: ['folder', 'folders'],
};
const OP_VERB: Record<string, string> = { create: 'to add', update: 'to change', delete: 'to remove' };

/** "3 elements to add, 1 relationship to change" — what a change set would do. */
export function opsSummary(ops: ChangeOp[]): string {
  if (!ops || ops.length === 0) return 'No changes: the file matches the model.';
  const groups = new Map<string, number>();
  for (const o of ops) {
    const key = `${o.kind}|${o.op}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, n]) => {
      const [kind, op] = key.split('|') as [string, string];
      const [one, many] = KIND_NOUN[kind] ?? [kind.replace(/_/g, ' '), `${kind.replace(/_/g, ' ')}s`];
      return `${n} ${n === 1 ? one : many} ${OP_VERB[op] ?? op}`;
    })
    .join(', ');
}

export function opLabel(op: ChangeOp): string {
  const [one] = KIND_NOUN[op.kind] ?? [op.kind.replace(/_/g, ' ')];
  const verb = op.op === 'create' ? 'Add' : op.op === 'update' ? 'Change' : op.op === 'delete' ? 'Remove' : op.op;
  return `${verb} ${one}`;
}

/** The name an op's attributes give the item, when they give one. */
export function opName(op: ChangeOp): string {
  const a = op.attributes ?? {};
  for (const k of ['title', 'name', 'label']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const LOSS_TEXT: Record<string, string> = {
  'STAGE-ORGANIZATIONS': 'Folders in the file are not kept; items are imported without their folder structure.',
  'STAGE-VIEW-PROPERTIES': 'Extra properties on views are not kept.',
  'STAGE-PROPERTY-DUPLICATE-KEY': 'A property appeared twice on one item; only one value is kept.',
  'STAGE-NAME-DEFAULTED': 'An item without a name was given a default name.',
  'STAGE-VIEWPOINT-DEFAULTED': 'A view without a viewpoint was set to the "layered" viewpoint.',
  'STAGE-TEXT-NORMALISED': 'Some text was tidied (spacing or line breaks).',
  'STAGE-MODEL-HEADER': 'Details in the file header (such as the model name or description) are not imported into an existing model.',
};

/** What an import or export could not carry, in words; RM's own message for codes we have no wording for. */
export function lossText(loss: ExchangeLoss): string {
  return LOSS_TEXT[loss.code] ?? loss.message;
}

/** Findings of a change set worth showing a user: the import bookkeeping record is not one. */
export function visibleFindings(cs: Pick<ChangeSet, 'findings'>): ChangeSet['findings'] {
  return (cs.findings ?? []).filter((f) => f.rule_id !== 'XI-META-001' && f.rule_id !== 'XI-LOSS-001');
}

export const VISIBILITY_LABEL: Record<string, string> = {
  tenant: 'Everyone in the workspace',
  user: 'Only the owner',
};

export function visibilityLabel(v: string): string {
  return VISIBILITY_LABEL[v] ?? v;
}

/** A short display form of a date, or a dash. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** The version name a user reads: "Version 3 — Release 1". */
export function versionName(rev: { seq: number; label: string | null }): string {
  return rev.label ? `Version ${rev.seq} — ${rev.label}` : `Version ${rev.seq}`;
}

/** An SVG as a base64 data URI — the only form in which RM's SVG reaches the page (inside a sandboxed iframe). */
export function svgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** One render diagnostic, as a sentence: RM's message, else its code. */
export function diagnosticText(d: Record<string, unknown>): string {
  for (const k of ['message', 'detail']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return typeof d.code === 'string' ? `Drawing note ${d.code}` : 'An unnamed drawing note';
}

/**
 * The end of the import headline ("The changes in <file> …"), from the change
 * set's CURRENT status: after Apply it says they were applied, never that they
 * are still ready to review.
 */
export function importOutcome(modelCreated: boolean, status: string): string {
  if (status === 'applied') return modelCreated ? 'and its contents were added.' : 'have been applied to the model.';
  if (status === 'rejected') return modelCreated ? 'but its contents were rejected; nothing was added.' : 'were rejected; nothing was changed.';
  if (status === 'invalid') return modelCreated ? 'but its contents cannot be added as they are; see the problems below.' : 'cannot be applied as they are; see the problems below.';
  return modelCreated ? 'and its contents are ready to add.' : 'are ready to review.';
}
