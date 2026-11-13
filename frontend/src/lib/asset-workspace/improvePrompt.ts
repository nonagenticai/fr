/**
 * The message "✨ Improve with agent" sends (AssetDetail.svelte).
 *
 * ⛔ fr#1383. The prompt used to carry the title and the rendered detail
 * fields only. Manifests do not list `id` as a detail field, so the agent never
 * learned the asset's identifier — it took the nearest stand-in it could see
 * (an architecture element's SLUG) and passed it to
 * `architecture.get_entity_graph`, whose `entity_id` is a UUID; the upstream
 * answered 422 on every attempt. The identifier the page itself loaded the
 * asset by is now stated explicitly, together with the collection it lives in.
 */
export interface ImprovePromptInput {
  /** Manifest singular, lower-cased by the caller, e.g. "element". */
  singular: string;
  /** Manifest `name`, i.e. the collection, e.g. "architecture/elements". */
  collection: string;
  /** The id the detail page loaded the asset by (the manifest's idField value). */
  id: string;
  title: string;
  content: string;
}

export function buildImprovePrompt(p: ImprovePromptInput): string {
  return (
    `Help me improve this ${p.singular}: "${p.title}".\n\n` +
    `Identifier: ${p.id} (collection: ${p.collection}). Use this exact identifier ` +
    `when a tool asks for this ${p.singular}'s id.\n\n` +
    `Current content:\n${p.content}\n\n` +
    `Suggest concrete improvements and draft an updated version I can review.`
  );
}
