/**
 * Smoke import test for the types package public surface (E10-B09).
 *
 * Coverage tools count every imported symbol against the file that
 * declares it; without at least one test importing from `./index.js`,
 * the re-export file shows 0% even though every underlying definition
 * is exercised by `result.test.ts` and `schemas.test.ts`. This test
 * imports every public name through the index and asserts it landed —
 * no behaviour to test, just instrument coverage correctly.
 */

import { describe, expect, it } from 'vitest';

import {
  CompilationSchema,
  MountSchema,
  PromotionSchema,
  RecallResultSchema,
  SourceSchema,
  TaskSchema,
  TaskStatusSchema,
  TraceEnvelopeSchema,
} from './index.js';

describe('@ico/types public surface', () => {
  it('exports every documented schema from the package barrel', () => {
    const schemas = {
      CompilationSchema,
      MountSchema,
      PromotionSchema,
      RecallResultSchema,
      SourceSchema,
      TaskSchema,
      TaskStatusSchema,
      TraceEnvelopeSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema, `${name} must be defined`).toBeDefined();
      // Every export is a Zod schema; sanity-check by parsing an obviously
      // invalid input and asserting the schema reports the failure.
      const result = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(
        Symbol('nope'),
      );
      expect(result.success, `${name} should reject Symbol input`).toBe(false);
    }
  });
});
