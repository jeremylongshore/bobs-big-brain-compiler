import { createHash } from 'node:crypto';

/** A client-reported completion identity, not provider authentication. */
export interface ModelCallProvenance {
  phase: 'summarize' | 'map' | 'reduce';
  /** Zero-based attempt within this phase/batch. */
  attempt: number;
  /** Zero-based map batch; absent for summary and reduce calls. */
  batchIndex?: number;
  responseModel: string;
  promptHashVersion: 'ico-prompt-v1';
  promptHash: string;
}

/**
 * Commit the exact two JavaScript prompt strings using UTF-8 JSON of the
 * version-tagged array. JSON escapes preserve boundaries and lone surrogates;
 * no trimming or Unicode normalization occurs. Options, transport framing,
 * responses and credentials are outside this commitment. Hashes neither
 * reconstruct prompts nor conceal guessable inputs.
 */
export function modelCallProvenance(
  systemPrompt: string,
  userPrompt: string,
  responseModel: string,
  identity: Pick<ModelCallProvenance, 'phase' | 'attempt' | 'batchIndex'>,
): ModelCallProvenance {
  return {
    ...identity,
    responseModel,
    promptHashVersion: 'ico-prompt-v1',
    promptHash: createHash('sha256')
      .update(JSON.stringify(['ico-prompt-v1', systemPrompt, userPrompt]), 'utf8')
      .digest('hex'),
  };
}

/** Keep first-seen call order and each distinct contributing completion. */
export function contributingModelCalls(
  inputIndices: readonly number[],
  rawPageCalls: readonly ModelCallProvenance[],
): ModelCallProvenance[] {
  return [
    ...new Set(
      inputIndices.map((index) => {
        const call = rawPageCalls[index];
        if (call === undefined) throw new Error('Missing raw-page model-call provenance');
        return call;
      }),
    ),
  ];
}
