// fr#1383 — "✨ Improve with agent" must tell the agent the asset's identifier.
// Without it the agent passed an architecture element's SLUG to
// architecture.get_entity_graph (entity_id: UUID) and got 422 on every retry.
import { describe, it, expect } from 'vitest';
import { buildImprovePrompt } from './improvePrompt';

describe('buildImprovePrompt', () => {
  const id = '0195f48b-d000-7000-8000-0000000000bb';
  const prompt = buildImprovePrompt({
    singular: 'element',
    collection: 'library/architecture/elements',
    id,
    title: 'Data Validation Service',
    content: 'Name: Data Validation Service\nSlug: data-validation-service',
  });

  it('states the identifier the page loaded the asset by, and its collection', () => {
    expect(prompt).toContain(`Identifier: ${id}`);
    expect(prompt).toContain('collection: library/architecture/elements');
  });

  it('keeps the title, the current content and the ask', () => {
    expect(prompt).toContain('Help me improve this element: "Data Validation Service".');
    expect(prompt).toContain('Current content:\nName: Data Validation Service');
    expect(prompt).toContain('Suggest concrete improvements');
  });
});
