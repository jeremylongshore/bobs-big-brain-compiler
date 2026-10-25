import { createHash } from 'node:crypto';

const PROMPT_HASH_VERSION = 'ico-prompt-v1' as const;

/** A client-reported completion identity, not provider authentication. */
export interface ModelCallProvenance {
  phase: 'summarize' | 'map' | 'reduce';
  /** Zero-based attempt within this phase/batch. */
  attempt: number;
  /** Zero-based map batch; absent for summary and reduce calls. */
  batchIndex?: number;
  responseModel: string;
  promptHashVersion: typeof PROMPT_HASH_VERSION;
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
    promptHashVersion: PROMPT_HASH_VERSION,
    promptHash: createHash('sha256')
      .update(JSON.stringify([PROMPT_HASH_VERSION, systemPrompt, userPrompt]), 'utf8')
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
