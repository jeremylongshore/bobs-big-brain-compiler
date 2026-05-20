/**
 * Tests for the task output gatherer (E8-B07).
 *
 * All tests operate on temporary directories — no database or network calls.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatherTaskOutput } from './task-renderer.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let wsPath: string;

beforeEach(() => {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-task-renderer-test-'));
});

afterEach(() => {
  rmSync(wsPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Ensure a directory exists. */
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Write a file, creating parent directories as needed. */
function writeFile(absolutePath: string, content: string): void {
  ensureDir(join(absolutePath, '..'));
  writeFileSync(absolutePath, content, 'utf-8');
}

/** Build a minimal completed status.json. */
function completedStatus(): string {
  return JSON.stringify({ status: 'completed', updated_at: '2024-01-15T10:00:00.000Z' });
}

/** Build an output markdown file with a frontmatter title. */
function outputFileWithTitle(title: string, body = 'Content.'): string {
  return `---\ntitle: "${title}"\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Successful gather
// ---------------------------------------------------------------------------

describe('gatherTaskOutput — successful gather', () => {
  it('returns ok with taskId and sources for a completed task', () => {
    const taskId = 'tsk-abc123';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'summary.md'), outputFileWithTitle('My Summary', 'Body text.'));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskId).toBe(taskId);
    expect(result.value.sources).toHaveLength(1);
  });

  it('uses the frontmatter title for each source', () => {
    const taskId = 'tsk-titles';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'doc.md'), outputFileWithTitle('My Document Title'));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.title).toBe('My Document Title');
  });

  it('uses filename as title fallback when frontmatter has no title', () => {
    const taskId = 'tsk-notitle';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'my-findings.md'), '## Findings\n\nStuff.\n');

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.title).toBe('my-findings');
  });

  it('gathers multiple output files sorted alphabetically', () => {
    const taskId = 'tsk-multi';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'beta.md'), outputFileWithTitle('Beta Doc'));
    writeFile(join(outputDir, 'alpha.md'), outputFileWithTitle('Alpha Doc'));
    writeFile(join(outputDir, 'gamma.md'), outputFileWithTitle('Gamma Doc'));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(3);
    // Files are sorted alphabetically by filename.
    expect(result.value.sources[0]?.title).toBe('Alpha Doc');
    expect(result.value.sources[1]?.title).toBe('Beta Doc');
    expect(result.value.sources[2]?.title).toBe('Gamma Doc');
  });

  it('sets the task title from the first gathered source', () => {
    const taskId = 'tsk-titlepick';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'aaa-first.md'), outputFileWithTitle('First Source'));
    writeFile(join(outputDir, 'zzz-last.md'), outputFileWithTitle('Last Source'));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('First Source');
  });

  it('accepts a completed task that has only an output/ directory (no status.json)', () => {
    const taskId = 'tsk-nostatus';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    // No status.json — only output/ directory.
    writeFile(join(outputDir, 'doc.md'), outputFileWithTitle('Doc Without Status'));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
  });

  it('strips frontmatter from content when returning sources', () => {
    const taskId = 'tsk-content';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(
      join(outputDir, 'doc.md'),
      '---\ntitle: "Content Test"\n---\n\n## Body\n\nActual content.\n',
    );

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // content should not contain the frontmatter block
    expect(result.value.sources[0]?.content).not.toContain('title:');
    expect(result.value.sources[0]?.content).toContain('## Body');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('gatherTaskOutput — error cases', () => {
  it('returns err for a non-existent task', () => {
    const result = gatherTaskOutput(wsPath, 'tsk-nonexistent');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not found');
  });

  it('returns err when task has no output directory and no status.json', () => {
    const taskId = 'tsk-empty';
    ensureDir(join(wsPath, 'tasks', taskId));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not eligible');
  });

  it('returns err when status.json says status is not completed', () => {
    const taskId = 'tsk-rendering';
    const taskDir = join(wsPath, 'tasks', taskId);

    writeFile(join(taskDir, 'status.json'), JSON.stringify({ status: 'rendering' }));

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('not eligible');
  });

  it('returns err when task has status.json (completed) but no output directory', () => {
    const taskId = 'tsk-no-output-dir';
    const taskDir = join(wsPath, 'tasks', taskId);

    writeFile(join(taskDir, 'status.json'), completedStatus());
    // No output/ directory created.

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no output/');
  });

  it('returns err when output directory exists but contains no .md files', () => {
    const taskId = 'tsk-no-md';
    const taskDir = join(wsPath, 'tasks', taskId);
    const outputDir = join(taskDir, 'output');

    writeFile(join(taskDir, 'status.json'), completedStatus());
    writeFile(join(outputDir, 'data.json'), '{}');

    const result = gatherTaskOutput(wsPath, taskId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no .md files');
  });
});
