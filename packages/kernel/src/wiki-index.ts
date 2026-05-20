import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { err, ok, type Result } from '@ico/types';

/**
 * Scanned wiki subdirectories, in display order.
 * Each entry maps a directory name (relative to wiki/) to a section label.
 */
const WIKI_SCAN_DIRS: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: 'sources', label: 'Sources' },
  { dir: 'concepts', label: 'Concepts' },
  { dir: 'entities', label: 'Entities' },
  { dir: 'topics', label: 'Topics' },
  { dir: 'contradictions', label: 'Contradictions' },
  { dir: 'open-questions', label: 'Open Questions' },
];

/**
 * Parse the YAML frontmatter block from a markdown file.
 *
 * Expects the file to begin with a `---` delimiter.  Extracts all
 * `key: value` pairs between the opening and closing `---` lines.
 * Returns an empty object when no frontmatter block is found.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!content.startsWith('---')) {
    return result;
  }

  // Find the closing delimiter — start searching after the first `---\n`
  const afterOpen = content.indexOf('\n') + 1;
  const closeIndex = content.indexOf('\n---', afterOpen);

  if (closeIndex === -1) {
    return result;
  }

  const block = content.slice(afterOpen, closeIndex);

  for (const line of block.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key !== '') {
      result[key] = value;
    }
  }

  return result;
}

interface IndexEntry {
  title: string;
  filename: string;
}

/**
 * Rebuild `wiki/index.md` from all compiled markdown pages found in the
 * scanned wiki subdirectories.
 *
 * Writes atomically: the content is first written to `wiki/index.md.tmp`
 * and then renamed to `wiki/index.md`, preventing a corrupt index if the
 * process crashes mid-write.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @returns             The total number of compiled pages indexed, or an Error.
 */
export function rebuildWikiIndex(workspacePath: string): Result<number, Error> {
  try {
    const wikiPath = resolve(workspacePath, 'wiki');
    const indexPath = resolve(wikiPath, 'index.md');
    const tmpPath = resolve(wikiPath, 'index.md.tmp');

    const sections: Array<{ label: string; dir: string; entries: IndexEntry[] }> = [];
    let totalCount = 0;

    for (const { dir, label } of WIKI_SCAN_DIRS) {
      const dirPath = resolve(wikiPath, dir);
      const entries: IndexEntry[] = [];

      if (existsSync(dirPath)) {
        const files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && f !== '.gitkeep');

        for (const filename of files) {
          const filePath = resolve(dirPath, filename);
          const content = readFileSync(filePath, 'utf-8');
          const fm = parseFrontmatter(content);
          const title = fm['title'] ?? basename(filename, '.md');
          entries.push({ title, filename });
        }

        // Sort entries alphabetically by title for deterministic output
        entries.sort((a, b) => a.title.localeCompare(b.title));
      }

      sections.push({ label, dir, entries });
      totalCount += entries.length;
    }

    const generatedAt = new Date().toISOString();
    const lines: string[] = [];

    // Frontmatter
    lines.push('---');
    lines.push('type: index');
    lines.push('title: Knowledge Index');
    lines.push(`generated_at: ${generatedAt}`);
    lines.push(`page_count: ${totalCount}`);
    lines.push('---');
    lines.push('');
    lines.push('# Knowledge Index');
    lines.push('');

    if (totalCount === 0) {
      lines.push('_No compiled pages yet._');
      lines.push('');
    } else {
      for (const { label, dir, entries } of sections) {
        lines.push(`## ${label} (${entries.length})`);
        lines.push('');

        if (entries.length === 0) {
          lines.push('_None yet._');
        } else {
          for (const { title, filename } of entries) {
            lines.push(`- [${title}](${dir}/${filename})`);
          }
        }

        lines.push('');
      }
    }

    const output = lines.join('\n');

    // Atomic write: tmp → rename
    writeFileSync(tmpPath, output, 'utf-8');
    renameSync(tmpPath, indexPath);

    return ok(totalCount);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
