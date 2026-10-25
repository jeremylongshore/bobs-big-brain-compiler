/** Resolve wiki references without guessing among colliding page identities. */
import { normalizeTitle } from './passes/batch-helper.js';

export interface WikiReferencePage {
  slug: string;
  content: string;
}

/** Piped labels do not participate in target identity. */
export function wikiReferences(content: string): Set<string> {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return new Set(
    [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
      .map((match) => match[1]?.trim() ?? '')
      .filter(Boolean),
  );
}

/** Exact filename stems win; otherwise accept only a unique normalized title. */
export function wikiReferenceResolver<T extends WikiReferencePage>(
  pages: readonly T[],
): (reference: string) => T | undefined {
  const filenames = new Map<string, T[]>();
  const aliases = new Map<string, T[]>();
  for (const page of pages) {
    const named = filenames.get(page.slug) ?? [];
    named.push(page);
    filenames.set(page.slug, named);
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(page.content)?.[1];
    // Canonical generated scalar titles; unsupported YAML stays unresolved.
    const rawTitle = header?.match(/^title:[ \t]*(.+)$/m)?.[1]?.trim();
    const title = rawTitle?.replace(/^(?:"([^"\n]*)"|'([^'\n]*)')$/, '$1$2');
    if (!title) continue;
    const key = normalizeTitle(title);
    if (!key) continue;
    const titled = aliases.get(key) ?? [];
    titled.push(page);
    aliases.set(key, titled);
  }
  return (reference) => {
    const exact = filenames.get(reference);
    if (exact) return exact.length === 1 ? exact[0] : undefined;
    const matches = aliases.get(normalizeTitle(reference));
    return matches?.length === 1 ? matches[0] : undefined;
  };
}
