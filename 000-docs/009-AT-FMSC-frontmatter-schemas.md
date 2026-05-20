# Frontmatter Schema Definitions for Compiled Page Types

> Seven types. Seven schemas. Zero ambiguity.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Overview

Every compiled page in the Semantic Knowledge layer (L2) carries YAML frontmatter that conforms to a strict schema for its page type. The compiler produces this frontmatter. The linter validates it. The kernel indexes it. No exceptions.

Seven compiled page types exist in L2:

| #   | Type             | Directory                        | Produced By     |
| --- | ---------------- | -------------------------------- | --------------- |
| 1   | `source-summary` | `workspace/wiki/sources/`        | Summarize pass  |
| 2   | `concept`        | `workspace/wiki/concepts/`       | Extract pass    |
| 3   | `topic`          | `workspace/wiki/topics/`         | Synthesize pass |
| 4   | `entity`         | `workspace/wiki/entities/`       | Extract pass    |
| 5   | `contradiction`  | `workspace/wiki/contradictions/` | Contradict pass |
| 6   | `open-question`  | `workspace/wiki/open-questions/` | Gap pass        |
| 7   | `semantic-index` | `workspace/wiki/indexes/`        | Index rebuild   |

**Conventions:**

- All frontmatter is YAML, delimited by `---` fences, parsed by `gray-matter`.
- All dates use ISO 8601 format (`YYYY-MM-DDTHH:mm:ssZ`).
- All `id` fields are UUIDv4 strings.
- All schemas are expressed as Zod definitions in TypeScript. These are the authoritative type definitions — the tables and examples are derived from them.
- Required means the page is invalid without it. Optional means the field may be absent; when present, it must conform to the declared type.

---

## 2. Source Summary (`source-summary`)

A source summary page is produced by the Summarize pass from a single raw source. It extracts key claims, methods, conclusions, and metadata from the source file. Stored in `workspace/wiki/sources/`.

### 2.1 Zod Schema

```typescript
import { z } from 'zod';

export const SourceSummaryFrontmatter = z.object({
  type: z.literal('source-summary'),
  id: z.string().uuid(),
  title: z.string().min(1),
  source_id: z.string().uuid(),
  source_path: z.string().min(1),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  content_hash: z.string().min(1),
  author: z.string().optional(),
  publication_date: z.string().datetime().optional(),
  word_count: z.number().int().nonnegative().optional(),
  key_claims: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
```

### 2.2 Field Reference

| Field              | Required | Type                | Description                                                                        |
| ------------------ | -------- | ------------------- | ---------------------------------------------------------------------------------- |
| `type`             | Yes      | `"source-summary"`  | Literal page type discriminator                                                    |
| `id`               | Yes      | `string` (UUIDv4)   | Unique identifier for this compiled page                                           |
| `title`            | Yes      | `string`            | Human-readable title derived from the source                                       |
| `source_id`        | Yes      | `string` (UUIDv4)   | Foreign key to the `sources` table in SQLite                                       |
| `source_path`      | Yes      | `string`            | Relative path to the raw source file in `workspace/raw/`                           |
| `compiled_at`      | Yes      | `string` (ISO 8601) | Timestamp when this page was compiled                                              |
| `model`            | Yes      | `string`            | Model identifier used for compilation (e.g., `claude-sonnet-4-6`)                  |
| `content_hash`     | Yes      | `string`            | SHA-256 hash of the source file at compilation time. Used for staleness detection. |
| `author`           | No       | `string`            | Author of the original source document                                             |
| `publication_date` | No       | `string` (ISO 8601) | Publication date of the original source                                            |
| `word_count`       | No       | `number` (integer)  | Word count of the original source document                                         |
| `key_claims`       | No       | `string[]`          | List of key claims extracted from the source                                       |
| `tags`             | No       | `string[]`          | Freeform classification tags                                                       |

### 2.3 Example

```markdown
---
type: source-summary
id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks'
source_id: 'f0e1d2c3-b4a5-6789-0abc-def123456789'
source_path: 'workspace/raw/papers/lewis-2020-rag.pdf'
compiled_at: '2026-04-06T14:32:00Z'
model: 'claude-sonnet-4-6'
content_hash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
author: 'Patrick Lewis et al.'
publication_date: '2020-05-22T00:00:00Z'
word_count: 8420
key_claims:
  - 'RAG combines parametric and non-parametric memory for language generation'
  - 'RAG models outperform parametric-only models on knowledge-intensive tasks'
  - 'Non-parametric memory can be updated without retraining'
tags:
  - 'retrieval-augmented-generation'
  - 'nlp'
  - 'knowledge-intensive'
---

# Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks

## Summary

Lewis et al. propose Retrieval-Augmented Generation (RAG), a model that combines
a pre-trained parametric memory (seq2seq transformer) with a non-parametric memory
(dense vector index of Wikipedia) accessed via a neural retriever...

## Key Claims

1. RAG combines parametric and non-parametric memory for language generation.
2. RAG models outperform parametric-only models on knowledge-intensive tasks.
3. Non-parametric memory can be updated without retraining.

## Methods

- Dense passage retrieval using bi-encoder architecture...

## Conclusions

The authors demonstrate that augmenting generation with retrieval provides
measurable improvements on open-domain QA, fact verification, and Jeopardy
question generation...
```

---

## 3. Concept (`concept`)

A concept page is produced by the Extract pass from source summaries. It defines a discrete concept, cites the sources it was extracted from, and links to related concepts. Stored in `workspace/wiki/concepts/`.

### 3.1 Zod Schema

```typescript
import { z } from 'zod';

export const ConceptFrontmatter = z.object({
  type: z.literal('concept'),
  id: z.string().uuid(),
  title: z.string().min(1),
  definition: z.string().min(1),
  source_ids: z.array(z.string().uuid()).min(1),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  related_concepts: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
```

### 3.2 Field Reference

| Field              | Required | Type                  | Description                                                           |
| ------------------ | -------- | --------------------- | --------------------------------------------------------------------- |
| `type`             | Yes      | `"concept"`           | Literal page type discriminator                                       |
| `id`               | Yes      | `string` (UUIDv4)     | Unique identifier for this compiled page                              |
| `title`            | Yes      | `string`              | Canonical name of the concept                                         |
| `definition`       | Yes      | `string`              | One-paragraph definition of the concept                               |
| `source_ids`       | Yes      | `string[]` (UUIDv4[]) | IDs of source summaries this concept was extracted from. Minimum one. |
| `compiled_at`      | Yes      | `string` (ISO 8601)   | Timestamp when this page was compiled                                 |
| `model`            | Yes      | `string`              | Model identifier used for compilation                                 |
| `aliases`          | No       | `string[]`            | Alternative names or abbreviations for this concept                   |
| `related_concepts` | No       | `string[]`            | Titles or IDs of related concept pages                                |
| `tags`             | No       | `string[]`            | Freeform classification tags                                          |

### 3.3 Example

```markdown
---
type: concept
id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
title: 'Non-Parametric Memory'
definition: 'A memory component in a neural system that stores knowledge in an external data structure (e.g., a dense vector index) rather than in model weights. Can be updated at inference time without retraining the model.'
source_ids:
  - 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  - 'c3d4e5f6-a7b8-9012-cdef-123456789012'
compiled_at: '2026-04-06T15:10:00Z'
model: 'claude-sonnet-4-6'
aliases:
  - 'external memory'
  - 'retrieval memory'
related_concepts:
  - 'Parametric Memory'
  - 'Dense Passage Retrieval'
  - 'Knowledge-Intensive Tasks'
tags:
  - 'memory-architecture'
  - 'retrieval'
---

# Non-Parametric Memory

## Definition

A memory component in a neural system that stores knowledge in an external data
structure (e.g., a dense vector index) rather than in model weights. Can be updated
at inference time without retraining the model.

## Discussion

Non-parametric memory is contrasted with parametric memory, where knowledge is
encoded in the learned weights of a neural network...

## Sources

- [[lewis-2020-rag]] — Introduces RAG architecture combining parametric and
  non-parametric memory
- [[karpukhin-2020-dpr]] — Dense Passage Retrieval as a non-parametric memory
  retrieval mechanism
```

---

## 4. Topic (`topic`)

A topic page is produced by the Synthesize pass from multiple source summaries and concept pages. It represents cross-source synthesis on a named topic. Stored in `workspace/wiki/topics/`.

### 4.1 Zod Schema

```typescript
import { z } from 'zod';

export const TopicFrontmatter = z.object({
  type: z.literal('topic'),
  id: z.string().uuid(),
  title: z.string().min(1),
  source_ids: z.array(z.string().uuid()).min(1),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  subtopics: z.array(z.string()).optional(),
  key_findings: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
```

### 4.2 Field Reference

| Field          | Required | Type                  | Description                                                       |
| -------------- | -------- | --------------------- | ----------------------------------------------------------------- |
| `type`         | Yes      | `"topic"`             | Literal page type discriminator                                   |
| `id`           | Yes      | `string` (UUIDv4)     | Unique identifier for this compiled page                          |
| `title`        | Yes      | `string`              | Name of the topic                                                 |
| `source_ids`   | Yes      | `string[]` (UUIDv4[]) | IDs of source summaries synthesized into this topic. Minimum one. |
| `compiled_at`  | Yes      | `string` (ISO 8601)   | Timestamp when this page was compiled                             |
| `model`        | Yes      | `string`              | Model identifier used for compilation                             |
| `subtopics`    | No       | `string[]`            | Named subtopic sections within this topic page                    |
| `key_findings` | No       | `string[]`            | High-level findings synthesized across sources                    |
| `tags`         | No       | `string[]`            | Freeform classification tags                                      |

### 4.3 Example

```markdown
---
type: topic
id: 'd4e5f6a7-b8c9-0123-def0-123456789abc'
title: 'Retrieval-Augmented Generation'
source_ids:
  - 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  - 'c3d4e5f6-a7b8-9012-cdef-123456789012'
  - 'e5f6a7b8-c9d0-1234-ef01-23456789abcd'
compiled_at: '2026-04-06T16:45:00Z'
model: 'claude-sonnet-4-6'
subtopics:
  - 'Architecture Variants'
  - 'Training Approaches'
  - 'Evaluation Benchmarks'
  - 'Limitations and Open Problems'
key_findings:
  - 'RAG consistently outperforms closed-book models on knowledge-intensive benchmarks'
  - 'Chunk size and retrieval strategy significantly affect generation quality'
  - 'No consensus on optimal integration point between retriever and generator'
tags:
  - 'retrieval-augmented-generation'
  - 'nlp'
  - 'survey'
---

# Retrieval-Augmented Generation

## Overview

Retrieval-Augmented Generation (RAG) combines a neural text generator with an
external knowledge retrieval mechanism. This topic synthesizes findings from
three source papers spanning 2020-2024...

## Architecture Variants

Multiple architectural approaches have emerged for integrating retrieval
into the generation pipeline...

## Training Approaches

...

## Evaluation Benchmarks

...

## Limitations and Open Problems

...
```

---

## 5. Entity (`entity`)

An entity page describes a named entity (person, organization, tool, framework, dataset, or other) referenced across sources. Stored in `workspace/wiki/entities/`.

### 5.1 Zod Schema

```typescript
import { z } from 'zod';

export const EntityTypeLiteral = z.enum([
  'person',
  'organization',
  'tool',
  'framework',
  'dataset',
  'other',
]);

export const EntityFrontmatter = z.object({
  type: z.literal('entity'),
  id: z.string().uuid(),
  title: z.string().min(1),
  entity_type: EntityTypeLiteral,
  source_ids: z.array(z.string().uuid()).min(1),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  description: z.string().optional(),
  related_entities: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
```

### 5.2 Field Reference

| Field              | Required | Type                                                                                    | Description                                                      |
| ------------------ | -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `type`             | Yes      | `"entity"`                                                                              | Literal page type discriminator                                  |
| `id`               | Yes      | `string` (UUIDv4)                                                                       | Unique identifier for this compiled page                         |
| `title`            | Yes      | `string`                                                                                | Canonical name of the entity                                     |
| `entity_type`      | Yes      | `"person"` \| `"organization"` \| `"tool"` \| `"framework"` \| `"dataset"` \| `"other"` | Classification of the entity                                     |
| `source_ids`       | Yes      | `string[]` (UUIDv4[])                                                                   | IDs of source summaries that reference this entity. Minimum one. |
| `compiled_at`      | Yes      | `string` (ISO 8601)                                                                     | Timestamp when this page was compiled                            |
| `model`            | Yes      | `string`                                                                                | Model identifier used for compilation                            |
| `aliases`          | No       | `string[]`                                                                              | Alternative names, abbreviations, or former names                |
| `url`              | No       | `string` (URL)                                                                          | Primary web URL for the entity                                   |
| `description`      | No       | `string`                                                                                | Brief description of the entity                                  |
| `related_entities` | No       | `string[]`                                                                              | Titles or IDs of related entity pages                            |
| `tags`             | No       | `string[]`                                                                              | Freeform classification tags                                     |

### 5.3 Valid Values for `entity_type`

| Value          | Use When                                       |
| -------------- | ---------------------------------------------- |
| `person`       | Named individual (researcher, author, founder) |
| `organization` | Company, university, lab, consortium           |
| `tool`         | Software tool, library, CLI utility            |
| `framework`    | Conceptual or software framework               |
| `dataset`      | Named dataset used in research or analysis     |
| `other`        | Entity that does not fit the above categories  |

### 5.4 Example

```markdown
---
type: entity
id: 'f6a7b8c9-d0e1-2345-f012-3456789abcde'
title: 'Anthropic'
entity_type: organization
source_ids:
  - 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  - 'e5f6a7b8-c9d0-1234-ef01-23456789abcd'
compiled_at: '2026-04-06T17:00:00Z'
model: 'claude-sonnet-4-6'
aliases:
  - 'Anthropic PBC'
url: 'https://www.anthropic.com'
description: 'AI safety company and developer of the Claude model family.'
related_entities:
  - 'Claude'
  - 'Dario Amodei'
  - 'Constitutional AI'
tags:
  - 'ai-safety'
  - 'llm-provider'
---

# Anthropic

## Overview

Anthropic is an AI safety company founded in 2021. It develops the Claude family
of large language models, with a focus on safe and steerable AI systems...

## Appearances in Corpus

- [[lewis-2020-rag]] — Referenced in discussion of foundation model providers
- [[constitutional-ai-2022]] — Primary research contribution

## Related Entities

- [[Claude]] — Model family developed by Anthropic
- [[Dario Amodei]] — Co-founder and CEO
- [[Constitutional AI]] — Training methodology developed by Anthropic
```

---

## 6. Contradiction (`contradiction`)

A contradiction note is produced by the Contradict pass. It flags claims that conflict across sources, identifying both sides and the sources they originate from. Stored in `workspace/wiki/contradictions/`.

### 6.1 Zod Schema

```typescript
import { z } from 'zod';

export const SeverityLiteral = z.enum(['low', 'medium', 'high']);

export const ContradictionFrontmatter = z.object({
  type: z.literal('contradiction'),
  id: z.string().uuid(),
  title: z.string().min(1),
  claim_a: z.string().min(1),
  claim_b: z.string().min(1),
  source_a_id: z.string().uuid(),
  source_b_id: z.string().uuid(),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  resolution: z.string().optional(),
  severity: SeverityLiteral.optional(),
  tags: z.array(z.string()).optional(),
});
```

### 6.2 Field Reference

| Field         | Required | Type                              | Description                                                |
| ------------- | -------- | --------------------------------- | ---------------------------------------------------------- |
| `type`        | Yes      | `"contradiction"`                 | Literal page type discriminator                            |
| `id`          | Yes      | `string` (UUIDv4)                 | Unique identifier for this compiled page                   |
| `title`       | Yes      | `string`                          | Short description of the contradiction                     |
| `claim_a`     | Yes      | `string`                          | The first conflicting claim                                |
| `claim_b`     | Yes      | `string`                          | The second conflicting claim                               |
| `source_a_id` | Yes      | `string` (UUIDv4)                 | ID of the source summary containing `claim_a`              |
| `source_b_id` | Yes      | `string` (UUIDv4)                 | ID of the source summary containing `claim_b`              |
| `compiled_at` | Yes      | `string` (ISO 8601)               | Timestamp when this page was compiled                      |
| `model`       | Yes      | `string`                          | Model identifier used for compilation                      |
| `resolution`  | No       | `string`                          | Explanation of how the contradiction is resolved, if known |
| `severity`    | No       | `"low"` \| `"medium"` \| `"high"` | Impact severity of the contradiction                       |
| `tags`        | No       | `string[]`                        | Freeform classification tags                               |

### 6.3 Valid Values for `severity`

| Value    | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `low`    | Minor factual disagreement with limited downstream impact        |
| `medium` | Substantive disagreement affecting interpretation of a topic     |
| `high`   | Fundamental conflict that undermines a core claim or methodology |

### 6.4 Example

```markdown
---
type: contradiction
id: 'a7b8c9d0-e1f2-3456-0123-456789abcdef'
title: 'Conflict on RAG vs Fine-Tuning for Domain Adaptation'
claim_a: 'RAG with domain-specific retrieval outperforms fine-tuning on domain QA benchmarks'
claim_b: 'Fine-tuning on domain corpora produces more reliable outputs than RAG for specialized domains'
source_a_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
source_b_id: 'e5f6a7b8-c9d0-1234-ef01-23456789abcd'
compiled_at: '2026-04-06T18:20:00Z'
model: 'claude-sonnet-4-6'
resolution: 'Likely domain-dependent. Lewis (2020) evaluates on open-domain QA; Chen (2024) evaluates on medical QA. Results may not generalize across domains.'
severity: medium
tags:
  - 'rag'
  - 'fine-tuning'
  - 'domain-adaptation'
---

# Conflict on RAG vs Fine-Tuning for Domain Adaptation

## Claim A

> RAG with domain-specific retrieval outperforms fine-tuning on domain QA benchmarks.

**Source:** [[lewis-2020-rag]]

Lewis et al. demonstrate that combining a pre-trained generator with a dense
retriever over domain documents produces state-of-the-art results on Natural
Questions, TriviaQA, and WebQuestions...

## Claim B

> Fine-tuning on domain corpora produces more reliable outputs than RAG for
> specialized domains.

**Source:** [[chen-2024-medical-llm]]

Chen et al. show that instruction-tuned models fine-tuned on curated medical
QA datasets outperform RAG-based systems on MedQA and PubMedQA...

## Analysis

The contradiction appears domain-dependent. Open-domain QA benchmarks favor
RAG because they require broad factual coverage. Specialized domains (medical,
legal) may favor fine-tuning because the knowledge is narrower and the precision
requirements are higher...

## Resolution

Likely domain-dependent. Lewis (2020) evaluates on open-domain QA; Chen (2024)
evaluates on medical QA. Results may not generalize across domains.
```

---

## 7. Open Question (`open-question`)

An open question is produced by the Gap pass. It identifies referenced-but-undefined concepts, missing evidence, or unanswered questions surfaced during compilation. Stored in `workspace/wiki/open-questions/`.

### 7.1 Zod Schema

```typescript
import { z } from 'zod';

export const PriorityLiteral = z.enum(['low', 'medium', 'high']);

export const OpenQuestionFrontmatter = z.object({
  type: z.literal('open-question'),
  id: z.string().uuid(),
  title: z.string().min(1),
  question: z.string().min(1),
  compiled_at: z.string().datetime(),
  model: z.string().min(1),
  context: z.string().optional(),
  related_concepts: z.array(z.string()).optional(),
  suggested_sources: z.array(z.string()).optional(),
  priority: PriorityLiteral.optional(),
  tags: z.array(z.string()).optional(),
});
```

### 7.2 Field Reference

| Field               | Required | Type                              | Description                                                             |
| ------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------- |
| `type`              | Yes      | `"open-question"`                 | Literal page type discriminator                                         |
| `id`                | Yes      | `string` (UUIDv4)                 | Unique identifier for this compiled page                                |
| `title`             | Yes      | `string`                          | Short label for the question                                            |
| `question`          | Yes      | `string`                          | The full question text                                                  |
| `compiled_at`       | Yes      | `string` (ISO 8601)               | Timestamp when this page was compiled                                   |
| `model`             | Yes      | `string`                          | Model identifier used for compilation                                   |
| `context`           | No       | `string`                          | Background explaining why this question was surfaced                    |
| `related_concepts`  | No       | `string[]`                        | Titles or IDs of concept pages related to this question                 |
| `suggested_sources` | No       | `string[]`                        | Titles, URLs, or descriptions of sources that might answer the question |
| `priority`          | No       | `"low"` \| `"medium"` \| `"high"` | Operator-assigned or model-suggested priority                           |
| `tags`              | No       | `string[]`                        | Freeform classification tags                                            |

### 7.3 Valid Values for `priority`

| Value    | Meaning                                               |
| -------- | ----------------------------------------------------- |
| `low`    | Peripheral gap — nice to resolve but not blocking     |
| `medium` | Substantive gap affecting understanding of a topic    |
| `high`   | Critical gap — a core concept or claim lacks evidence |

### 7.4 Example

```markdown
---
type: open-question
id: 'b8c9d0e1-f2a3-4567-1234-56789abcdef0'
title: 'Optimal Chunk Size for RAG Retrieval'
question: 'What is the optimal chunk size for dense passage retrieval in RAG systems, and how does it vary by domain and document type?'
compiled_at: '2026-04-06T18:45:00Z'
model: 'claude-sonnet-4-6'
context: 'Multiple sources reference chunk size as a critical parameter but none provide systematic comparison across domains.'
related_concepts:
  - 'Dense Passage Retrieval'
  - 'Non-Parametric Memory'
  - 'Retrieval-Augmented Generation'
suggested_sources:
  - 'Llamaindex chunking strategies documentation'
  - 'Langchain text splitter benchmarks'
  - "Search for: 'optimal chunk size RAG retrieval benchmark 2024'"
priority: medium
tags:
  - 'rag'
  - 'retrieval'
  - 'chunking'
---

# Optimal Chunk Size for RAG Retrieval

## Question

What is the optimal chunk size for dense passage retrieval in RAG systems, and
how does it vary by domain and document type?

## Context

Multiple sources reference chunk size as a critical parameter but none provide
systematic comparison across domains. Lewis (2020) uses 100-word passages;
Karpukhin (2020) uses fixed-length segments. Neither justifies the choice
empirically.

## Related Concepts

- [[Dense Passage Retrieval]]
- [[Non-Parametric Memory]]
- [[Retrieval-Augmented Generation]]

## Suggested Sources

- Llamaindex chunking strategies documentation
- Langchain text splitter benchmarks
- Academic search: "optimal chunk size RAG retrieval benchmark 2024"
```

---

## 8. Semantic Index (`semantic-index`)

A semantic index is an auto-generated catalog page that lists and links compiled knowledge by type or across all types. The primary instance is `workspace/wiki/index.md` (scope: `all`). Type-specific indexes are stored in `workspace/wiki/indexes/`.

### 8.1 Zod Schema

```typescript
import { z } from 'zod';

export const IndexScopeLiteral = z.enum([
  'sources',
  'concepts',
  'topics',
  'entities',
  'contradictions',
  'open-questions',
  'all',
]);

export const SemanticIndexFrontmatter = z.object({
  type: z.literal('semantic-index'),
  id: z.string().uuid(),
  title: z.string().min(1),
  scope: IndexScopeLiteral,
  generated_at: z.string().datetime(),
  entry_count: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
});
```

### 8.2 Field Reference

| Field          | Required | Type                                                                                                             | Description                                                       |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `type`         | Yes      | `"semantic-index"`                                                                                               | Literal page type discriminator                                   |
| `id`           | Yes      | `string` (UUIDv4)                                                                                                | Unique identifier for this index page                             |
| `title`        | Yes      | `string`                                                                                                         | Title of the index (e.g., "Source Index", "Full Knowledge Index") |
| `scope`        | Yes      | `"sources"` \| `"concepts"` \| `"topics"` \| `"entities"` \| `"contradictions"` \| `"open-questions"` \| `"all"` | Which compiled page types this index covers                       |
| `generated_at` | Yes      | `string` (ISO 8601)                                                                                              | Timestamp when this index was last generated                      |
| `entry_count`  | No       | `number` (integer)                                                                                               | Total number of entries listed in this index                      |
| `tags`         | No       | `string[]`                                                                                                       | Freeform classification tags                                      |

### 8.3 Valid Values for `scope`

| Value            | Indexes                              |
| ---------------- | ------------------------------------ |
| `sources`        | All source summary pages             |
| `concepts`       | All concept pages                    |
| `topics`         | All topic pages                      |
| `entities`       | All entity pages                     |
| `contradictions` | All contradiction notes              |
| `open-questions` | All open question pages              |
| `all`            | Every compiled page across all types |

### 8.4 Example

```markdown
---
type: semantic-index
id: 'c9d0e1f2-a3b4-5678-2345-6789abcdef01'
title: 'Full Knowledge Index'
scope: all
generated_at: '2026-04-06T19:00:00Z'
entry_count: 47
tags:
  - 'auto-generated'
---

# Full Knowledge Index

> Auto-generated catalog of all compiled knowledge. Last rebuilt: 2026-04-06T19:00:00Z.

## Sources (12)

| Title                                                                                         | ID       | Compiled   |
| --------------------------------------------------------------------------------------------- | -------- | ---------- |
| [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](sources/lewis-2020-rag.md) | a1b2c3d4 | 2026-04-06 |
| [Dense Passage Retrieval for Open-Domain QA](sources/karpukhin-2020-dpr.md)                   | c3d4e5f6 | 2026-04-06 |
| ...                                                                                           | ...      | ...        |

## Concepts (18)

| Title                                                          | ID       | Sources |
| -------------------------------------------------------------- | -------- | ------- |
| [Non-Parametric Memory](concepts/non-parametric-memory.md)     | b2c3d4e5 | 2       |
| [Dense Passage Retrieval](concepts/dense-passage-retrieval.md) | d4e5f6a7 | 3       |
| ...                                                            | ...      | ...     |

## Topics (5)

| Title                                                                      | ID       | Sources |
| -------------------------------------------------------------------------- | -------- | ------- |
| [Retrieval-Augmented Generation](topics/retrieval-augmented-generation.md) | d4e5f6a7 | 3       |
| ...                                                                        | ...      | ...     |

## Entities (7)

| Title                              | Type         | ID       |
| ---------------------------------- | ------------ | -------- |
| [Anthropic](entities/anthropic.md) | organization | f6a7b8c9 |
| ...                                | ...          | ...      |

## Contradictions (3)

| Title                                                                  | Severity | ID       |
| ---------------------------------------------------------------------- | -------- | -------- |
| [Conflict on RAG vs Fine-Tuning](contradictions/rag-vs-fine-tuning.md) | medium   | a7b8c9d0 |
| ...                                                                    | ...      | ...      |

## Open Questions (2)

| Title                                                                        | Priority | ID       |
| ---------------------------------------------------------------------------- | -------- | -------- |
| [Optimal Chunk Size for RAG Retrieval](open-questions/optimal-chunk-size.md) | medium   | b8c9d0e1 |
| ...                                                                          | ...      | ...      |
```

---

## 9. Common Fields

These fields appear across all seven page types. They are listed here once to avoid repetition.

| Field          | Present In  | Type                  | Description                                                                                                                        |
| -------------- | ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | All 7 types | `string` (literal)    | Discriminator. Exactly one of: `source-summary`, `concept`, `topic`, `entity`, `contradiction`, `open-question`, `semantic-index`. |
| `id`           | All 7 types | `string` (UUIDv4)     | Globally unique identifier. Generated at compilation time.                                                                         |
| `title`        | All 7 types | `string`              | Human-readable title. Non-empty.                                                                                                   |
| `compiled_at`  | Types 1-6   | `string` (ISO 8601)   | When the page was compiled. Absent from `semantic-index` (uses `generated_at`).                                                    |
| `generated_at` | Type 7 only | `string` (ISO 8601)   | When the index was generated. Equivalent role to `compiled_at`.                                                                    |
| `model`        | Types 1-6   | `string`              | Model identifier used for compilation. Absent from `semantic-index` (indexes are deterministically generated, not model-produced). |
| `tags`         | All 7 types | `string[]` (optional) | Freeform classification tags. Always optional.                                                                                     |

### Discriminated Union

The `type` field serves as a discriminator for a Zod discriminated union. The combined schema for any compiled page is:

```typescript
import { z } from 'zod';

export const CompiledPageFrontmatter = z.discriminatedUnion('type', [
  SourceSummaryFrontmatter,
  ConceptFrontmatter,
  TopicFrontmatter,
  EntityFrontmatter,
  ContradictionFrontmatter,
  OpenQuestionFrontmatter,
  SemanticIndexFrontmatter,
]);

export type CompiledPageFrontmatter = z.infer<typeof CompiledPageFrontmatter>;
```

This union is the single entry point for frontmatter validation. Given any compiled page, parse its frontmatter through `CompiledPageFrontmatter` and the `type` field routes to the correct schema.

---

## 10. Validation Rules

Cross-field and cross-page constraints that the linter enforces beyond per-field type checking.

### 10.1 Referential Integrity

| Rule                                                          | Applies To                   | Constraint                                             |
| ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `source_id` must exist in `sources` table                     | `source-summary`             | The referenced raw source must be registered in SQLite |
| `source_ids` entries must exist in `sources` table            | `concept`, `topic`, `entity` | Every referenced source ID must be a registered source |
| `source_a_id` and `source_b_id` must exist in `sources` table | `contradiction`              | Both conflicting sources must be registered            |
| `source_a_id` and `source_b_id` must differ                   | `contradiction`              | A source cannot contradict itself                      |

### 10.2 Uniqueness

| Rule                                 | Scope              | Constraint                                                                                |
| ------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `id` must be globally unique         | All compiled pages | No two pages across any type may share an `id`                                            |
| `title` should be unique within type | Per-type directory | Two concept pages should not share a title. Enforced as a lint warning, not a hard error. |

### 10.3 Temporal Constraints

| Rule                                          | Applies To       | Constraint                                              |
| --------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `compiled_at` must not be in the future       | Types 1-6        | Compilation timestamp cannot exceed current system time |
| `generated_at` must not be in the future      | `semantic-index` | Generation timestamp cannot exceed current system time  |
| `publication_date` must precede `compiled_at` | `source-summary` | A source cannot be published after it was compiled      |

### 10.4 Content Constraints

| Rule                                    | Applies To       | Constraint                                                                                                                           |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `content_hash` must match source file   | `source-summary` | At compile time, the hash in frontmatter must match `sha256(<source file bytes>)`. A mismatch after compilation indicates staleness. |
| `definition` must be non-empty prose    | `concept`        | Not just a title repeat. Minimum meaningful definition.                                                                              |
| `claim_a` and `claim_b` must differ     | `contradiction`  | The two claims must be substantively different                                                                                       |
| `question` must end with `?`            | `open-question`  | Enforced as a lint warning. Questions should be interrogative.                                                                       |
| `entry_count` must match actual entries | `semantic-index` | If present, must equal the number of entries listed in the page body                                                                 |

### 10.5 Staleness Detection

A compiled page is flagged as stale by `ico lint knowledge` when any of these conditions hold:

1. **Source hash mismatch.** The `content_hash` in a `source-summary` no longer matches the SHA-256 of the corresponding raw source file.
2. **New source matches topic.** A `topic` page's subject overlaps with a newly ingested source not listed in its `source_ids`.
3. **Dependency recompiled.** A page that backlinks to another page whose `compiled_at` is more recent than its own `compiled_at`.

Stale pages are queued for recompilation by `ico compile all`.

---

## 11. File Naming Convention

Compiled page filenames follow a deterministic pattern derived from the title.

```
<kebab-case-title>.md
```

Rules:

- Title is lowercased, spaces replaced with hyphens, non-alphanumeric characters (except hyphens) removed.
- Maximum filename length: 80 characters (excluding `.md` extension). Truncate at a word boundary if needed.
- The `id` field is the authoritative identifier, not the filename. Filenames are for human readability.

Examples:

- Title: "Retrieval-Augmented Generation" -> `retrieval-augmented-generation.md`
- Title: "Non-Parametric Memory" -> `non-parametric-memory.md`
- Title: "Conflict on RAG vs Fine-Tuning for Domain Adaptation" -> `conflict-on-rag-vs-fine-tuning-for-domain-adaptation.md`

---

## 12. Versioning

This schema document is frozen for Phase 1. Changes require:

1. An entry in `000-docs/IDEA-CHANGELOG.md` with rationale.
2. Update to this document with a new version number.
3. Corresponding update to the Zod schemas in `packages/types/`.
4. Review of all compiled pages for conformance with the new schema.
5. Update to the glossary (`008-AT-GLOS-glossary.md`) if new terms are introduced.

**Cross-references:** Blueprint Section 5.4, Blueprint Section 6.1, Architecture, Tech Spec, Glossary.
