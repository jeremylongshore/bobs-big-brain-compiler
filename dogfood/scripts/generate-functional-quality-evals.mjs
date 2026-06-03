#!/usr/bin/env node
/**
 * Generate functional-quality eval specs from a dogfood question bank.
 *
 * Reads an immutable question bank (e.g.
 * `dogfood/question-banks/intent-eval-core-v2.yaml`, ADR-029/031) and emits
 * one `.eval.yaml` spec per (intent × paraphrase) into
 * `dogfood/evals/functional-quality/<bank>/`. Each paraphrase becomes a
 * standalone `functional-quality` spec sharing its intent's hand-authored
 * ground truth (`expected_substrings`, `expected_sources`, `recall_floor`,
 * `verification_mode`) — exactly the per-intent boundary the bank defines.
 *
 * ADR-031: the bank is immutable once cited in a real run. This generator
 * only READS it. Regenerating is always safe and deterministic — the output
 * is a pure function of the bank. Fix bank typos by authoring a new bank
 * version, never by editing generated specs or the bank in place.
 *
 * The pass `threshold` of each generated spec is set to the bank's
 * `recall_floor` for that intent: the only quantitative bar the bank
 * authors. Operators may tune thresholds in the generated specs, but
 * regeneration overwrites them — tune the bank or the generator instead.
 *
 * Usage:
 *   node dogfood/scripts/generate-functional-quality-evals.mjs \
 *     [--bank dogfood/question-banks/intent-eval-core-v2.yaml] \
 *     [--out  dogfood/evals/functional-quality]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DOGFOOD = resolve(HERE, '..');
const REPO_ROOT = resolve(REPO_DOGFOOD, '..');

// js-yaml is a workspace dependency of @ico/kernel, not hoisted to where this
// standalone script lives. Resolve it from the kernel package so the generator
// runs from anywhere without its own node_modules.
const requireFromKernel = createRequire(resolve(REPO_ROOT, 'packages/kernel/package.json'));
const { dump, load } = requireFromKernel('js-yaml');

function parseArgs(argv) {
  const args = { bank: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bank') args.bank = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
  }
  return args;
}

/** Lowercase-kebab a string, collapse runs, trim leading/trailing dashes. */
function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function main() {
  const { bank: bankArg, out: outArg } = parseArgs(process.argv.slice(2));
  const bankPath = resolve(
    bankArg ?? join(REPO_DOGFOOD, 'question-banks', 'intent-eval-core-v2.yaml'),
  );
  const bank = load(readFileSync(bankPath, 'utf-8'));
  if (!bank || !Array.isArray(bank.questions)) {
    throw new Error(`Bank ${bankPath} has no 'questions' array`);
  }

  const bankName = basename(bankPath).replace(/\.ya?ml$/, '');
  const outDir = resolve(outArg ?? join(REPO_DOGFOOD, 'evals', 'functional-quality'), bankName);

  // Clean + recreate the per-bank output dir so removed paraphrases don't
  // leave orphan specs behind. Only this generated subtree is touched.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let count = 0;
  for (const q of bank.questions) {
    const intentText = String(q.intent ?? '').trim();
    const substrings = q.expected_substrings ?? [];
    const sources = q.expected_sources ?? [];
    const recallFloor = typeof q.recall_floor === 'number' ? q.recall_floor : 0;
    const mode = q.verification_mode === 'weak' ? 'weak' : 'strong';
    const paraphrases = Array.isArray(q.paraphrases) ? q.paraphrases : [];

    for (const p of paraphrases) {
      const style = String(p.style ?? 'direct');
      const id = `fq-${slug(bankName)}-${slug(q.id)}-${slug(style)}`;
      const spec = {
        id,
        name: `${q.id} / ${style} — ${bank.target ?? bankName}`,
        type: 'functional-quality',
        question: String(p.text ?? '').trim(),
        intent: intentText,
        verification_mode: mode,
        expected_substrings: substrings,
        expected_sources: sources,
        recall_floor: recallFloor,
        threshold: recallFloor,
      };
      const header =
        `# GENERATED from ${basename(bankPath)} (${q.id} / ${style}) — do not edit by hand.\n` +
        `# Regenerate: node dogfood/scripts/generate-functional-quality-evals.mjs\n` +
        `# Ground truth is per-intent and immutable (ADR-031); edit the bank version, not this file.\n`;
      writeFileSync(
        join(outDir, `${id}.eval.yaml`),
        header + dump(spec, { lineWidth: 100 }),
        'utf-8',
      );
      count += 1;
    }
  }

  process.stdout.write(`Generated ${count} functional-quality specs into ${outDir}\n`);
}

main();
