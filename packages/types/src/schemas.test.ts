import { describe, expect, it } from 'vitest';

import {
  CompilationSchema,
  MountSchema,
  PromotionSchema,
  RecallResultSchema,
  SourceSchema,
  TaskSchema,
  TraceEnvelopeSchema,
} from './schemas.js';

describe('SourceSchema', () => {
  it('validates a complete source record', () => {
    const source = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      path: 'workspace/raw/articles/sample.md',
      type: 'markdown' as const,
      title: 'Sample Article',
      author: 'Test Author',
      ingested_at: '2026-04-06T00:00:00Z',
      word_count: 1500,
      hash: 'abc123def456',
      metadata: null,
    };
    expect(SourceSchema.parse(source)).toEqual(source);
  });

  it('rejects invalid source type', () => {
    const bad = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      path: 'test.md',
      type: 'docx',
      title: null,
      author: null,
      ingested_at: '2026-04-06T00:00:00Z',
      word_count: null,
      hash: 'abc',
      metadata: null,
    };
    expect(() => SourceSchema.parse(bad)).toThrow();
  });
});

describe('TaskSchema', () => {
  it('validates all 7 task statuses', () => {
    const statuses = [
      'created',
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ] as const;
    for (const status of statuses) {
      const task = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        brief: 'Test task',
        status,
        created_at: '2026-04-06T00:00:00Z',
        completed_at: null,
        workspace_path: 'workspace/tasks/test-001',
      };
      expect(TaskSchema.parse(task).status).toBe(status);
    }
  });

  it('rejects invalid task status', () => {
    const bad = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      brief: 'Test',
      status: 'active',
      created_at: '2026-04-06T00:00:00Z',
      completed_at: null,
      workspace_path: 'workspace/tasks/test',
    };
    expect(() => TaskSchema.parse(bad)).toThrow();
  });
});

describe('TraceEnvelopeSchema', () => {
  it('validates a trace event with prev_hash', () => {
    const trace = {
      timestamp: '2026-04-06T00:00:00Z',
      event_type: 'ingest',
      event_id: '550e8400-e29b-41d4-a716-446655440000',
      correlation_id: '660e8400-e29b-41d4-a716-446655440000',
      payload: { path: 'test.md', hash: 'abc123' },
      prev_hash: 'deadbeef',
    };
    expect(TraceEnvelopeSchema.parse(trace)).toEqual(trace);
  });

  it('allows null prev_hash for chain anchor', () => {
    const trace = {
      timestamp: '2026-04-06T00:00:00Z',
      event_type: 'ingest',
      event_id: '550e8400-e29b-41d4-a716-446655440000',
      correlation_id: null,
      payload: {},
      prev_hash: null,
    };
    expect(TraceEnvelopeSchema.parse(trace).prev_hash).toBeNull();
  });
});

describe('CompilationSchema', () => {
  it('validates all compilation types', () => {
    const types = [
      'summary',
      'concept',
      'topic',
      'entity',
      'contradiction',
      'open-question',
    ] as const;
    for (const type of types) {
      const comp = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        source_id: '660e8400-e29b-41d4-a716-446655440000',
        type,
        output_path: `workspace/wiki/sources/test.md`,
        compiled_at: '2026-04-06T00:00:00Z',
        model: 'claude-sonnet-4-6',
        tokens_used: 1500,
      };
      expect(CompilationSchema.parse(comp).type).toBe(type);
    }
  });
});

describe('PromotionSchema', () => {
  it('validates a promotion record', () => {
    const promo = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      source_path: 'workspace/outputs/reports/analysis.md',
      target_path: 'workspace/wiki/topics/analysis.md',
      target_type: 'topic' as const,
      promoted_at: '2026-04-06T00:00:00Z',
      promoted_by: 'user' as const,
      source_hash: 'abc123',
    };
    expect(PromotionSchema.parse(promo)).toEqual(promo);
  });
});

describe('MountSchema', () => {
  it('validates a mount record', () => {
    const mount = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'research-papers',
      path: '/home/user/papers',
      created_at: '2026-04-06T00:00:00Z',
      last_indexed_at: null,
    };
    expect(MountSchema.parse(mount)).toEqual(mount);
  });
});

describe('RecallResultSchema', () => {
  it('validates a recall result', () => {
    const recall = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      concept: 'knowledge-compilation',
      correct: true,
      tested_at: '2026-04-06T00:00:00Z',
      confidence: 0.85,
    };
    expect(RecallResultSchema.parse(recall)).toEqual(recall);
  });
});
