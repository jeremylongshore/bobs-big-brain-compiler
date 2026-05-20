import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { err, ok, type Result } from '@ico/types';

export interface WorkspaceInfo {
  name: string;
  root: string;
  dbPath: string;
  createdAt: string;
}

/**
 * Subdirectories to create under the workspace root.
 * Paths are relative to the workspace root.
 */
const WORKSPACE_DIRS: readonly string[] = [
  'raw/articles',
  'raw/papers',
  'raw/repos',
  'raw/notes',
  'wiki/sources',
  'wiki/concepts',
  'wiki/entities',
  'wiki/topics',
  'wiki/contradictions',
  'wiki/open-questions',
  'wiki/indexes',
  'tasks',
  'outputs/reports',
  'outputs/slides',
  'outputs/charts',
  'outputs/briefings',
  'recall/cards',
  'recall/decks',
  'recall/quizzes',
  'recall/retention',
  'audit/traces',
  'audit/provenance',
  'audit/policy',
  'audit/promotions',
  '.ico',
];

/**
 * Wiki subdirectories that receive a .gitkeep file to ensure they are
 * tracked by git even when empty.
 */
const WIKI_GITKEEP_DIRS: readonly string[] = [
  'wiki/sources',
  'wiki/concepts',
  'wiki/entities',
  'wiki/topics',
  'wiki/contradictions',
  'wiki/open-questions',
  'wiki/indexes',
];

const SIZE_LIMITS_POLICY = {
  pdf: 52428800,
  markdown: 5242880,
  html: 10485760,
  text: 5242880,
  code: 2097152,
  json: 10485760,
  image: 20971520,
  other: 5242880,
};

/**
 * Initialize a new ICO workspace at `${basePath}/${name}/`.
 *
 * Creates the full directory tree required by the workspace policy,
 * seeds initial files (wiki index, audit log, size-limits policy), and
 * places `.gitkeep` files in every wiki subdirectory so git tracks them
 * when empty.
 *
 * The operation is idempotent: existing directories are left intact and
 * existing seed files are never overwritten.
 *
 * @param name     - Workspace name; used as the root directory name.
 * @param basePath - Parent directory under which the workspace is created.
 * @returns        WorkspaceInfo on success, or an Error on failure.
 */
export function initWorkspace(name: string, basePath: string): Result<WorkspaceInfo, Error> {
  try {
    const createdAt = new Date().toISOString();
    const root = resolve(basePath, name);

    // Create all required directories (recursive + force for idempotency)
    for (const dir of WORKSPACE_DIRS) {
      mkdirSync(resolve(root, dir), { recursive: true });
    }

    // Place .gitkeep in every wiki subdirectory
    for (const dir of WIKI_GITKEEP_DIRS) {
      const gitkeepPath = resolve(root, dir, '.gitkeep');
      if (!existsSync(gitkeepPath)) {
        writeFileSync(gitkeepPath, '', 'utf-8');
      }
    }

    // Seed wiki/index.md (do not overwrite)
    const wikiIndexPath = resolve(root, 'wiki', 'index.md');
    if (!existsSync(wikiIndexPath)) {
      writeFileSync(
        wikiIndexPath,
        [
          '---',
          'type: index',
          'title: Knowledge Index',
          `generated_at: ${createdAt}`,
          '---',
          '',
          '# Knowledge Index',
          '',
          '_No compiled pages yet._',
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    // Seed audit/log.md (do not overwrite)
    const auditLogPath = resolve(root, 'audit', 'log.md');
    if (!existsSync(auditLogPath)) {
      writeFileSync(
        auditLogPath,
        [
          '# ICO Audit Log',
          '',
          '| Timestamp | Operation | Summary |',
          '|-----------|-----------|---------|',
          `| ${createdAt} | workspace.init | Workspace "${name}" initialized |`,
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    // Seed audit/policy/size-limits.json (do not overwrite)
    const sizeLimitsPath = resolve(root, 'audit', 'policy', 'size-limits.json');
    if (!existsSync(sizeLimitsPath)) {
      writeFileSync(sizeLimitsPath, JSON.stringify(SIZE_LIMITS_POLICY, null, 2) + '\n', 'utf-8');
    }

    const dbPath = resolve(root, '.ico', 'state.db');

    return ok({
      name,
      root,
      dbPath,
      createdAt,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
