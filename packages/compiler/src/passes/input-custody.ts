import {
  type CustodyRoot,
  type Database,
  invalidateInputCustody,
  readInputCustody,
  recordInputCustody,
} from '@ico/kernel';
import { type Result } from '@ico/types';

/** null means incomplete custody, never an empty trusted source set. */
export type InputClosure = CustodyRoot[] | null;

export function captureInput(db: Database, path: string, content: string): InputClosure {
  const result = readInputCustody(db, path, content);
  return result.ok ? result.value : null;
}

export function unionInputs(inputs: readonly InputClosure[]): InputClosure {
  if (inputs.length === 0 || inputs.some((input) => input === null)) return null;
  return inputs.flatMap((input) => input ?? []);
}

/** Preserve ordinary compilation of legacy pages, but invalidate signing eligibility.
 * The caller supplies deterministic call-input membership, never model references.
 */
export function settleOutputCustody(
  db: Database,
  path: string,
  content: string,
  inputs: readonly InputClosure[],
): Result<void, Error> {
  const roots = unionInputs(inputs);
  // Invalidate first: a failed replacement may not leave an old same-byte receipt.
  const invalidated = invalidateInputCustody(db, path);
  if (!invalidated.ok || roots === null) return invalidated;
  return recordInputCustody(db, path, content, roots);
}
