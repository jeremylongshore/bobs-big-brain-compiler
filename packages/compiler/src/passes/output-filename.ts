import { createHash } from 'node:crypto';

export type WikiOutputKind =
  | 'summary'
  | 'concept'
  | 'entity'
  | 'topic'
  | 'contradiction'
  | 'open-question';

/**
 * A readable, bounded filename with a full logical-identity commitment.
 * The tagged JSON preimage separates page kinds and exact identity strings.
 * Content is deliberately absent so a body edit preserves the output name.
 * Callers supply the canonical comparison key for derived pages; summaries
 * retain their basename stem, so renaming that source can still change its path.
 */
export function wikiOutputFilename(kind: WikiOutputKind, logicalId: string, stem: string): string {
  if (logicalId.trim().length === 0) throw new Error('Wiki output requires a logical identity');
  const readable = stem
    .toLowerCase()
    .replace(/\+/g, '-plus-')
    .replace(/#/g, '-hash-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/g, '');
  if (readable.length === 0) throw new Error('Wiki output requires a readable stem');
  const digest = createHash('sha256')
    .update(JSON.stringify(['ico-wiki-output-v1', kind, logicalId]), 'utf8')
    .digest('hex');
  return `${readable}--${digest}.md`;
}
