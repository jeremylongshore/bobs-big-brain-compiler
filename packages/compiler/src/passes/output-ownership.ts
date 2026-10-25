import { lstatSync, readFileSync } from 'node:fs';

import type { Database } from '@ico/kernel';

import { extractFrontmatterField } from './batch-helper.js';
import type { WikiOutputKind } from './output-filename.js';

/**
 * Refuse a target already attributed to another logical page before staging.
 * This is a read-only consistency check, not a filesystem transaction or a
 * defense against concurrent same-user path/content replacement.
 */
export function assertWikiOutputOwnership(
  db: Database,
  outputPath: string,
  absoluteOutputPath: string,
  kind: WikiOutputKind,
  logicalId: string,
): void {
  // Derived IDs are globally unique in the existing schema, even though output
  // filenames include kind. Refuse a cross-kind upsert before staging a file.
  if (kind !== 'summary') {
    const identityOwner = db
      .prepare<[string], { type: string }>('SELECT type FROM compilations WHERE id = ?')
      .get(logicalId);
    if (identityOwner !== undefined && identityOwner.type !== kind) {
      throw new Error('Refusing wiki output with a conflicting compilation identity');
    }
  }

  const owners = db
    .prepare<
      [string],
      { id: string; source_id: string | null; type: string }
    >('SELECT id, source_id, type FROM compilations WHERE output_path = ?')
    .all(outputPath);
  if (
    owners.some(
      (owner) =>
        owner.type !== kind ||
        (kind === 'summary' ? owner.source_id !== logicalId : owner.id !== logicalId),
    )
  ) {
    throw new Error('Refusing wiki output with a conflicting compilation owner');
  }

  let present: boolean;
  try {
    const stat = lstatSync(absoluteOutputPath);
    if (!stat.isFile()) throw new Error('Refusing nonregular wiki output target');
    present = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    present = false;
  }
  if (!present) return;
  const content = readFileSync(absoluteOutputPath, 'utf8');
  const header = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---(?:[\t ]*(?:\r?\n|$))/.exec(
    content.trimStart(),
  )?.[1];
  if (header === undefined)
    throw new Error('Refusing wiki output without an initial identity header');
  const identityField = kind === 'summary' ? 'source_id' : 'id';
  const expectedType = kind === 'summary' ? 'source-summary' : kind;
  const exactlyOne = (field: string): boolean =>
    header.split('\n').filter((line) => line.startsWith(field + ':')).length === 1;
  if (
    !exactlyOne(identityField) ||
    !exactlyOne('type') ||
    extractFrontmatterField(header, identityField) !== logicalId ||
    extractFrontmatterField(header, 'type') !== expectedType
  ) {
    throw new Error('Refusing wiki output with a missing or conflicting header owner');
  }
}
