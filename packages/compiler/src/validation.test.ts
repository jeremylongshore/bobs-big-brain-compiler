import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCompiledPage, validateFrontmatter } from './validation.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeTmp(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixtures — valid pages
// ---------------------------------------------------------------------------

const VALID_SOURCE_SUMMARY = `---
type: source-summary
id: 123e4567-e89b-12d3-a456-426614174000
title: Understanding TypeScript Generics
source_id: 223e4567-e89b-12d3-a456-426614174001
source_path: raw/notes/typescript-generics.md
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
content_hash: abc123def456
tags: [typescript, generics, programming]
---
# Understanding TypeScript Generics

Summary body goes here.
`;

const VALID_CONCEPT = `---
type: concept
id: 323e4567-e89b-12d3-a456-426614174002
title: Type Inference
definition: The ability of the compiler to deduce types automatically from context.
source_ids: [223e4567-e89b-12d3-a456-426614174001, 423e4567-e89b-12d3-a456-426614174003]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: [typescript, types]
---
# Type Inference

Concept body.
`;

const VALID_TOPIC = `---
type: topic
id: 523e4567-e89b-12d3-a456-426614174004
title: Advanced TypeScript Patterns
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
---
# Advanced TypeScript Patterns

Topic body.
`;

const VALID_ENTITY = `---
type: entity
id: 623e4567-e89b-12d3-a456-426614174005
title: Microsoft
entity_type: organization
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
---
# Microsoft

Entity body.
`;

const VALID_CONTRADICTION = `---
type: contradiction
id: 723e4567-e89b-12d3-a456-426614174006
title: Structural vs Nominal Typing Debate
claim_a: TypeScript uses structural typing exclusively.
claim_b: TypeScript supports nominal typing via branded types.
source_a_id: 223e4567-e89b-12d3-a456-426614174001
source_b_id: 423e4567-e89b-12d3-a456-426614174003
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
---
# Structural vs Nominal Typing Debate

Contradiction body.
`;

const VALID_OPEN_QUESTION = `---
type: open-question
id: 823e4567-e89b-12d3-a456-426614174007
title: When should you prefer type aliases over interfaces?
question: In what scenarios does using a type alias produce better outcomes than an interface declaration?
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
priority: high
---
# When should you prefer type aliases over interfaces?

Open question body.
`;

// ---------------------------------------------------------------------------
// Fixtures — invalid pages
// ---------------------------------------------------------------------------

/** Missing required `source_id` field. */
const MISSING_REQUIRED_FIELD = `---
type: source-summary
id: 123e4567-e89b-12d3-a456-426614174000
title: Missing Source Id
source_path: raw/notes/test.md
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
content_hash: abc123
---
Body.
`;

/** The `type` field contains an unrecognised value. */
const WRONG_TYPE_FIELD = `---
type: magic-page
id: 123e4567-e89b-12d3-a456-426614174000
title: Wrong Type
---
Body.
`;

/** No frontmatter block at all. */
const NO_FRONTMATTER = `# Just a heading

No frontmatter block here.
`;

// ---------------------------------------------------------------------------
// Suite: validateCompiledPage
// ---------------------------------------------------------------------------

describe('validateCompiledPage', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ico-validation-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes a valid source-summary page', () => {
    const filePath = writeTmp('source-summary.md', VALID_SOURCE_SUMMARY);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('source-summary');
    expect(result.value.errors).toHaveLength(0);
  });

  it('fails with a specific error when a required field is missing', () => {
    const filePath = writeTmp('missing-field.md', MISSING_REQUIRED_FIELD);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(false);
    expect(result.value.pageType).toBe('source-summary');
    expect(result.value.errors.length).toBeGreaterThan(0);
    // source_id is the missing required UUID field.
    const hasSourceIdError = result.value.errors.some((e) => e.includes('source_id'));
    expect(hasSourceIdError).toBe(true);
  });

  it('fails when the type field contains an unknown value', () => {
    const filePath = writeTmp('wrong-type.md', WRONG_TYPE_FIELD);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(false);
    expect(result.value.pageType).toBe('magic-page');
    expect(result.value.errors.length).toBeGreaterThan(0);
    expect(result.value.errors[0]).toMatch(/Unknown page type/);
  });

  it('passes a valid concept page', () => {
    const filePath = writeTmp('concept.md', VALID_CONCEPT);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('concept');
    expect(result.value.errors).toHaveLength(0);
  });

  it('passes a valid topic page', () => {
    const filePath = writeTmp('topic.md', VALID_TOPIC);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('topic');
    expect(result.value.errors).toHaveLength(0);
  });

  it('passes a valid entity page', () => {
    const filePath = writeTmp('entity.md', VALID_ENTITY);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('entity');
    expect(result.value.errors).toHaveLength(0);
  });

  it('passes a valid contradiction page', () => {
    const filePath = writeTmp('contradiction.md', VALID_CONTRADICTION);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('contradiction');
    expect(result.value.errors).toHaveLength(0);
  });

  it('passes a valid open-question page', () => {
    const filePath = writeTmp('open-question.md', VALID_OPEN_QUESTION);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.valid).toBe(true);
    expect(result.value.pageType).toBe('open-question');
    expect(result.value.errors).toHaveLength(0);
  });

  it('returns err when the file does not exist', () => {
    const result = validateCompiledPage(join(tmpDir, 'nonexistent.md'));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/ENOENT|no such file/i);
  });

  it('returns err when the file has no frontmatter block', () => {
    const filePath = writeTmp('no-frontmatter.md', NO_FRONTMATTER);
    const result = validateCompiledPage(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/No frontmatter block/);
  });
});

// ---------------------------------------------------------------------------
// Suite: validateFrontmatter (without file I/O)
// ---------------------------------------------------------------------------

describe('validateFrontmatter', () => {
  it('validates a valid source-summary frontmatter object directly', () => {
    const frontmatter = {
      type: 'source-summary',
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Direct Validation Test',
      source_id: '223e4567-e89b-12d3-a456-426614174001',
      source_path: 'raw/notes/test.md',
      compiled_at: '2024-01-15T10:00:00.000Z',
      model: 'claude-opus-4',
      content_hash: 'abc123',
    };

    const result = validateFrontmatter(frontmatter, 'source-summary');

    expect(result.valid).toBe(true);
    expect(result.pageType).toBe('source-summary');
    expect(result.errors).toHaveLength(0);
  });

  it('returns an error for an unknown page type without reading a file', () => {
    const result = validateFrontmatter({ type: 'unknown-type' }, 'unknown-type');

    expect(result.valid).toBe(false);
    expect(result.pageType).toBe('unknown-type');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Unknown page type/);
  });

  it('reports schema errors for a concept missing definition and source_ids', () => {
    const frontmatter = {
      type: 'concept',
      id: '323e4567-e89b-12d3-a456-426614174002',
      title: 'Incomplete Concept',
      // missing: definition, source_ids, compiled_at, model
    };

    const result = validateFrontmatter(frontmatter, 'concept');

    expect(result.valid).toBe(false);
    expect(result.pageType).toBe('concept');
    expect(result.errors.length).toBeGreaterThan(0);

    const fields = result.errors.join(' ');
    expect(fields).toMatch(/definition|source_ids|compiled_at|model/);
  });

  it('passes a fully valid entity frontmatter object', () => {
    const frontmatter = {
      type: 'entity',
      id: '623e4567-e89b-12d3-a456-426614174005',
      title: 'Anders Hejlsberg',
      entity_type: 'person',
      source_ids: ['223e4567-e89b-12d3-a456-426614174001'],
      compiled_at: '2024-01-15T10:00:00.000Z',
      model: 'claude-opus-4',
    };

    const result = validateFrontmatter(frontmatter, 'entity');

    expect(result.valid).toBe(true);
    expect(result.pageType).toBe('entity');
    expect(result.errors).toHaveLength(0);
  });
});
