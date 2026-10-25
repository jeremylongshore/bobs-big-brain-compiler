import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

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

  let descriptor: number;
  try {
    descriptor = openSync(
      absoluteOutputPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ELOOP')
        throw new Error('Refusing nonregular wiki output target', { cause: error });
    }
    throw error;
  }
  let content: string;
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(absoluteOutputPath);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error('Refusing changed or nonregular wiki output target');
    }
    content = readFileSync(descriptor, 'utf8');
    const after = lstatSync(absoluteOutputPath);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Refusing changed wiki output target');
    }
  } finally {
    closeSync(descriptor);
  }
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
