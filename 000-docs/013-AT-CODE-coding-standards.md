# TypeScript Coding Standards and Package Conventions

> One way to write it. Zero ambiguity.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Scope and Authority

This document is the authoritative source for how TypeScript is written in `intentional-cognition-os`. It covers compiler settings, import style, error handling, logging, naming, SQL safety, secrets handling, and the error boundary pattern between deterministic and probabilistic system layers.

Every package in this monorepo (`packages/types/`, `packages/kernel/`, `packages/compiler/`, `packages/cli/`) inherits these conventions. Deviations require an explicit architectural decision recorded in `000-docs/IDEA-CHANGELOG.md`.

---

## 2. TypeScript Compiler Configuration

### 2.1 Root tsconfig.json (copy-pasteable)

Place this at the repository root. All package-level `tsconfig.json` files extend it.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "tsBuildInfoFile": ".tsbuildinfo",

    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "useUnknownInCatchVariables": true,

    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,

    "esModuleInterop": false,
    "allowSyntheticDefaultImports": false,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,

    "skipLibCheck": false
  },
  "exclude": ["node_modules", "dist", "**/*.test.ts", "evals"]
}
```

### 2.2 Per-package tsconfig.json (extend pattern)

Each package has its own `tsconfig.json` that extends the root and overrides only `rootDir` and `outDir`.

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "references": []
}
```

### 2.3 Key flag rationale

| Flag                           | Why it is on                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `module: "NodeNext"`           | Matches Node.js 22 ESM resolution exactly                                                     |
| `moduleResolution: "NodeNext"` | Requires explicit `.js` extensions in imports — no magic                                      |
| `verbatimModuleSyntax`         | Enforces `import type` for type-only imports; eliminates runtime import surprises             |
| `exactOptionalPropertyTypes`   | `{ x?: string }` does not allow `x: undefined` — distinguishes absent from explicit undefined |
| `noUncheckedIndexedAccess`     | Array and record index access returns `T \| undefined` — forces correct null handling         |
| `useUnknownInCatchVariables`   | Caught values are `unknown`, not `any` — requires explicit narrowing                          |
| `isolatedModules`              | Each file is independently transpilable; required for tsup compatibility                      |
| `skipLibCheck: false`          | Type errors in dependencies are visible; do not mask third-party problems                     |

---

## 3. Module System

### 3.1 ESM only

Every package sets `"type": "module"` in `package.json`. CommonJS is not used anywhere in this codebase.

**Do:**

```typescript
// src/kernel/workspace.ts
import { readFile } from 'node:fs/promises';
import type { WorkspaceConfig } from '../types/workspace.js';
import { initDb } from './state.js';
```

**Do not:**

```typescript
// CJS syntax is banned
const fs = require('fs');
const { initDb } = require('./state');
module.exports = { createWorkspace };
```

### 3.2 Import rules

- Always use explicit `.js` extensions in relative imports (required by `NodeNext` resolution, even for `.ts` source files).
- Prefer `node:` protocol for Node built-ins (`node:fs`, `node:path`, `node:crypto`).
- Use `import type` for any import used only as a type. `verbatimModuleSyntax` enforces this at compile time.
- No barrel re-export files (`index.ts` that re-exports everything). Import from the specific module.

**Do:**

```typescript
import type { SourceRecord } from '../types/source.js';
import { createHash } from 'node:crypto';
```

**Do not:**

```typescript
import { SourceRecord } from '../types/index.js'; // barrel file
import crypto from 'crypto'; // missing node: prefix
```

### 3.3 Import ordering

Enforce this order, separated by blank lines:

1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`better-sqlite3`, `zod`, `commander`)
3. Internal workspace packages (`@ico/types`, `@ico/kernel`)
4. Relative imports (`./state.js`, `../lib/output.js`)

ESLint enforces this order via `import/order`.

---

## 4. Error Handling

### 4.1 Result type

Library code (kernel, compiler, types) never throws. All fallible operations return a `Result<T, E>`.

```typescript
// packages/types/src/result.ts
export type Result<T, E extends Error = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends Error>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

### 4.2 Using Result

**Do:**

```typescript
import { ok, err, type Result } from '@ico/types';

async function ingestSource(path: string): Promise<Result<SourceRecord>> {
  const content = await readFile(path, 'utf-8').catch((e: unknown) => {
    return err(new Error(`Failed to read ${path}: ${String(e)}`));
  });
  if (!content.ok) return content;

  const record = buildRecord(path, content.value);
  return ok(record);
}
```

**Do not:**

```typescript
// Never throw in library code
async function ingestSource(path: string): Promise<SourceRecord> {
  const content = await readFile(path, 'utf-8'); // throws on error — banned
  return buildRecord(path, content);
}
```

### 4.3 The throw boundary

`throw` is legal in exactly one place: the CLI command handlers (`packages/cli/src/commands/*.ts`), where an unrecoverable error should terminate the process with a non-zero exit code.

```typescript
// packages/cli/src/commands/ingest.ts — CLI boundary
import { ingestSource } from '@ico/kernel';

export async function runIngest(path: string): Promise<void> {
  const result = await ingestSource(path);
  if (!result.ok) {
    // CLI boundary: convert Result error to process exit
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }
  console.log(`Ingested: ${result.value.id}`);
}
```

### 4.4 Catch clause narrowing

`useUnknownInCatchVariables` is on. All catch clauses receive `unknown`. Narrow before use.

**Do:**

```typescript
try {
  await riskyOperation();
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return err(new Error(`Operation failed: ${message}`));
}
```

**Do not:**

```typescript
try {
  await riskyOperation();
} catch (e: any) {
  // any is banned in catch
  return err(new Error(e.message));
}
```

---

## 5. Naming Conventions

| Category                                   | Convention                                   | Example                                           |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| File names                                 | kebab-case                                   | `source-record.ts`, `compile-pass.ts`             |
| Directories                                | kebab-case                                   | `packages/kernel/`, `open-questions/`             |
| Types, interfaces, classes                 | PascalCase                                   | `SourceRecord`, `CompilerPass`, `WorkspaceConfig` |
| Enums                                      | PascalCase (enum), SCREAMING_SNAKE (members) | `TaskStatus.IN_PROGRESS`                          |
| Functions, methods                         | camelCase                                    | `ingestSource()`, `buildRecord()`                 |
| Variables, parameters                      | camelCase                                    | `sourceId`, `outputPath`                          |
| Constants (module-level, never reassigned) | SCREAMING_SNAKE_CASE                         | `DEFAULT_MODEL`, `MAX_RETRIES`                    |
| Zod schemas                                | camelCase with `Schema` suffix               | `sourceRecordSchema`, `workspaceConfigSchema`     |
| Test files                                 | same name as source + `.test.ts`             | `state.test.ts`                                   |

### 5.1 File naming examples

**Do:**

```
packages/kernel/src/source-registry.ts
packages/compiler/src/summarize-pass.ts
packages/types/src/compilation-result.ts
```

**Do not:**

```
packages/kernel/src/SourceRegistry.ts   // PascalCase file name
packages/compiler/src/summarizePass.ts  // camelCase file name
packages/types/src/compilationresult.ts // no word boundary
```

### 5.2 Interface vs type alias

Use `interface` for object shapes that may be extended or implemented. Use `type` for unions, intersections, mapped types, and aliases that are not meant to be extended.

```typescript
// Use interface — can be implemented, describes a shape
interface SourceRecord {
  id: string;
  path: string;
  hash: string;
  ingestedAt: string;
}

// Use type — union, not a shape
type CompilationStatus = 'pending' | 'running' | 'done' | 'failed';

// Use type — Result is a discriminated union
type Result<T, E extends Error = Error> = { ok: true; value: T } | { ok: false; error: E };
```

---

## 6. Logging Conventions

### 6.1 Log levels

Use `ICO_LOG_LEVEL` environment variable. Valid values: `debug`, `info`, `warn`, `error`. Default: `info`.

| Level   | When to use                                                       |
| ------- | ----------------------------------------------------------------- |
| `debug` | Internal state transitions, SQL queries, API call parameters      |
| `info`  | Meaningful operations: ingest, compile, promote, task lifecycle   |
| `warn`  | Recoverable issues: stale pages, missing optional fields, retries |
| `error` | Operation failures that return a `Result<never, E>`               |

### 6.2 Structured log format

All log entries are JSON objects written to stderr. Do not use `console.log` for operational logging in library code. The CLI package may use `chalk` for formatted terminal output directed at the user.

```typescript
// packages/kernel/src/logger.ts
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  ts: string; // ISO 8601
  component: string; // e.g., 'kernel.state', 'compiler.summarize'
  msg: string;
  data?: Record<string, unknown>;
}

export function log(entry: LogEntry): void {
  process.stderr.write(JSON.stringify(entry) + '\n');
}
```

**Do:**

```typescript
log({
  level: 'info',
  ts: new Date().toISOString(),
  component: 'kernel.ingest',
  msg: 'Source ingested',
  data: redactSecrets({ sourceId: record.id, path: record.path, hash: record.hash }),
});
```

**Do not:**

```typescript
console.log(`Ingested ${record.path} with key ${apiKey}`); // unstructured, unredacted
```

---

## 7. Secret Redaction

### 7.1 Requirement

Every log entry and every JSONL audit trace that records `data` of type `Record<string, unknown>` must pass through `redactSecrets()` before writing. No exceptions.

### 7.2 Function signature

```typescript
// packages/types/src/redact.ts

/**
 * Strip sensitive values from a data object before logging or tracing.
 *
 * Patterns redacted:
 * - Keys matching: apiKey, api_key, authorization, token, secret, password, credential
 * - Values matching: /^sk-ant-/i, /^Bearer /i
 *
 * @param obj - The data object to redact. Shallow — nested objects are not recursed.
 * @returns A new object with sensitive values replaced by "[REDACTED]".
 */
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    'apikey',
    'api_key',
    'authorization',
    'token',
    'secret',
    'password',
    'credential',
    'passwd',
  ]);
  const SENSITIVE_VALUE_PATTERNS = [/^sk-ant-/i, /^Bearer /i];

  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        return [key, '[REDACTED]'];
      }
      if (typeof value === 'string') {
        for (const pattern of SENSITIVE_VALUE_PATTERNS) {
          if (pattern.test(value)) {
            return [key, '[REDACTED]'];
          }
        }
      }
      return [key, value];
    }),
  );
}
```

### 7.3 Usage rule

**Do:**

```typescript
log({
  level: 'debug',
  ts: new Date().toISOString(),
  component: 'compiler.summarize',
  msg: 'Calling Claude API',
  data: redactSecrets({ model, sourceId, authorization: apiKey }),
});
```

**Do not:**

```typescript
log({
  level: 'debug',
  ts: new Date().toISOString(),
  component: 'compiler.summarize',
  msg: 'Calling Claude API',
  data: { model, sourceId, authorization: apiKey }, // apiKey logged in plaintext
});
```

---

## 8. SQL Injection Prevention

### 8.1 Rule

All SQLite operations use `better-sqlite3` prepared statements. String interpolation into SQL is banned without exception.

### 8.2 Do

```typescript
// packages/kernel/src/state.ts
import Database from 'better-sqlite3';

const db = new Database('workspace.db');

// Prepared statement — parameter binding, never interpolation
const insertSource = db.prepare(`
  INSERT INTO sources (id, path, type, hash, ingested_at)
  VALUES (@id, @path, @type, @hash, @ingestedAt)
`);

export function registerSource(record: SourceRecord): void {
  insertSource.run({
    id: record.id,
    path: record.path,
    type: record.type,
    hash: record.hash,
    ingestedAt: record.ingestedAt,
  });
}

// Parameterized query — same rule
const selectByHash = db.prepare('SELECT * FROM sources WHERE hash = ?');

export function findByHash(hash: string): SourceRecord | undefined {
  return selectByHash.get(hash) as SourceRecord | undefined;
}
```

### 8.3 Do not

```typescript
// String interpolation into SQL — banned
function findByHash(hash: string): SourceRecord | undefined {
  return db.exec(`SELECT * FROM sources WHERE hash = '${hash}'`); // SQL injection vector
}

// db.exec() with dynamic values — banned
function deleteSource(id: string): void {
  db.exec(`DELETE FROM sources WHERE id = '${id}'`); // never use db.exec() with user values
}
```

### 8.4 When db.exec() is allowed

`db.exec()` is only allowed for static DDL (schema creation and migration scripts) where no user-supplied or runtime values appear in the string.

```typescript
// Allowed — static DDL, no runtime values
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    ingested_at TEXT NOT NULL
  );
`);
```

---

## 9. Error Boundary Between Deterministic and Probabilistic Layers

### 9.1 Architectural rule

The compiler package (`packages/compiler/`) calls the Claude API (probabilistic). The kernel package (`packages/kernel/`) owns state, audit, and lifecycle (deterministic). The boundary between them must be explicit.

Every call from kernel into compiler, and every call the compiler makes to the Claude API, is wrapped in a try/catch that converts thrown exceptions into typed `Result` errors with context. Exceptions must never cross the boundary as unhandled throws.

### 9.2 Compiler-internal boundary (Claude API calls)

```typescript
// packages/compiler/src/summarize-pass.ts

import Anthropic from '@anthropic-ai/sdk';
import { ok, err, type Result } from '@ico/types';
import { redactSecrets } from '@ico/types';
import { log } from '@ico/kernel';

export interface SummaryOutput {
  sourceId: string;
  summary: string;
  concepts: string[];
  tokensUsed: number;
}

export class CompilerError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CompilerError';
  }
}

export async function summarizeSource(
  client: Anthropic,
  sourceId: string,
  content: string,
  model: string,
): Promise<Result<SummaryOutput, CompilerError>> {
  log({
    level: 'debug',
    ts: new Date().toISOString(),
    component: 'compiler.summarize',
    msg: 'Starting summarization',
    data: redactSecrets({ sourceId, model, contentLength: content.length }),
  });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildSummarizePrompt(content) }],
    });

    const text = extractText(response);
    const parsed = parseSummaryResponse(text);

    return ok({
      sourceId,
      summary: parsed.summary,
      concepts: parsed.concepts,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    });
  } catch (e: unknown) {
    // Convert all exceptions to Result errors — nothing escapes this boundary
    const message = e instanceof Error ? e.message : String(e);
    const error = new CompilerError(`Summarization failed for source ${sourceId}: ${message}`, {
      sourceId,
      model,
    });
    log({
      level: 'error',
      ts: new Date().toISOString(),
      component: 'compiler.summarize',
      msg: error.message,
      data: redactSecrets({ sourceId, model }),
    });
    return err(error);
  }
}
```

### 9.3 Kernel-to-compiler boundary (calling compiler from deterministic code)

```typescript
// packages/kernel/src/compilation-service.ts

import { summarizeSource } from '@ico/compiler';
import type { CompilerError } from '@ico/compiler';
import { ok, err, type Result } from '@ico/types';
import { registerCompilation } from './state.js';
import { writeAuditTrace } from './audit.js';

export interface CompilationRecord {
  id: string;
  sourceId: string;
  outputPath: string;
  compiledAt: string;
  tokensUsed: number;
}

export class KernelCompilationError extends Error {
  constructor(
    message: string,
    public readonly cause: CompilerError,
  ) {
    super(message);
    this.name = 'KernelCompilationError';
  }
}

export async function compileSource(
  sourceId: string,
  content: string,
): Promise<Result<CompilationRecord, KernelCompilationError>> {
  // Compiler is probabilistic — its result is always a Result, never a throw
  const compileResult = await summarizeSource(
    anthropicClient,
    sourceId,
    content,
    process.env['ICO_MODEL'] ?? 'claude-sonnet-4-6',
  );

  if (!compileResult.ok) {
    // Wrap compiler error with kernel context, stay in Result
    return err(
      new KernelCompilationError(
        `Kernel failed to compile source ${sourceId}`,
        compileResult.error,
      ),
    );
  }

  // Deterministic side owns state writes — compiler never writes directly
  const record = await persistCompilation(sourceId, compileResult.value);
  await writeAuditTrace({ event: 'compilation', sourceId, ...record });

  return ok(record);
}
```

### 9.4 What the boundary enforces

- The compiler never writes to SQLite directly. It returns data; the kernel writes it.
- The compiler never writes audit traces directly. It returns results; the kernel traces the outcome.
- The kernel never calls `client.messages.create()`. That belongs to the compiler.
- Every exception from the Claude API is caught inside the compiler and returned as `Result<T, CompilerError>`.
- Every `CompilerError` that reaches the kernel is wrapped in a `KernelCompilationError` with additional context before being returned up to the CLI.

---

## 10. Package.json Conventions for Workspace Packages

### 10.1 Root workspace package.json template

```json
{
  "name": "intentional-cognition-os",
  "version": "0.1.0",
  "private": true,
  "description": "Local-first knowledge operating system.",
  "type": "module",
  "packageManager": "pnpm@10.8.1",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "audit:deps": "pnpm audit --audit-level=moderate"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### 10.2 Workspace package package.json template

Apply this scaffold to each of `packages/types/`, `packages/kernel/`, `packages/compiler/`, `packages/cli/`. Replace `<package-name>`, `<description>`, and `<dependencies>` as appropriate.

```json
{
  "name": "@ico/<package-name>",
  "version": "0.1.0",
  "private": true,
  "description": "<description>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@ico/types": "workspace:*",
    "typescript": "^5.0.0",
    "tsup": "^8.0.0",
    "vitest": "^4.0.0",
    "eslint": "^10.0.0",
    "typescript-eslint": "^8.0.0"
  }
}
```

### 10.3 pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
```

### 10.4 Package naming rules

- All workspace packages use the `@ico/` scope.
- The `name` field in each package matches the directory name: `packages/kernel/` → `@ico/kernel`.
- Internal cross-package references use `"workspace:*"` as the version specifier — never a semver range.

**Do:**

```json
{
  "dependencies": {
    "@ico/types": "workspace:*",
    "@ico/kernel": "workspace:*"
  }
}
```

**Do not:**

```json
{
  "dependencies": {
    "@ico/types": "^0.1.0",
    "@ico/kernel": "*"
  }
}
```

---

## 11. Dependency Audit in CI

### 11.1 Rule

`pnpm audit` runs as a required gate in every CI pipeline. A moderate or higher severity finding blocks merge.

### 11.2 CI step (`.github/workflows/ci.yml`)

```yaml
jobs:
  audit:
    name: Dependency Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Audit dependencies
        run: pnpm audit --audit-level=moderate
```

### 11.3 Suppressing false positives

If a finding is a known false positive or has no fix available, add an entry to `.pnpmauditignore` at the repository root with the CVE ID and a dated justification comment. Do not lower the `--audit-level` to suppress findings.

```
# .pnpmauditignore
# CVE-2024-XXXXX — affects only browser environments, ico is Node.js only. Reviewed 2026-04-06.
GHSA-xxxx-xxxx-xxxx
```

---

## 12. Build Tool Configuration

### 12.1 tsup config per package

```typescript
// packages/kernel/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: false,
});
```

`bundle: false` is intentional for library packages — each file is compiled individually, preserving the module graph for consumers. The CLI package (`packages/cli/`) sets `bundle: true` to produce a self-contained binary.

### 12.2 Vitest config per package

```typescript
// packages/kernel/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
```

---

## 13. Formatting and Editor Config

These rules are enforced by `.editorconfig` at the repository root. They are not negotiable and are not overridden at the package level.

| Setting                  | Value      |
| ------------------------ | ---------- |
| Indent style             | spaces     |
| Indent size              | 2          |
| End of line              | LF         |
| Charset                  | UTF-8      |
| Trim trailing whitespace | true       |
| Insert final newline     | true       |
| Max line length          | 100 (soft) |

Prettier is not used. ESLint handles formatting-adjacent rules (unused vars, import order). The editorconfig handles whitespace.

---

## 14. Quick Reference

| Rule                                                                                  | Verdict                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `"type": "module"` in package.json                                                    | Required                                    |
| Explicit `.js` extensions in relative imports                                         | Required                                    |
| `import type` for type-only imports                                                   | Required                                    |
| `throw` in library code (`packages/kernel/`, `packages/compiler/`, `packages/types/`) | Banned                                      |
| `throw` in CLI command handlers (`packages/cli/`)                                     | Allowed for fatal errors only               |
| `any` in catch clauses                                                                | Banned — use `unknown`                      |
| `db.exec()` with runtime values                                                       | Banned                                      |
| `db.prepare(sql).run(params)`                                                         | Required for all data mutations             |
| `redactSecrets()` before logging data                                                 | Required                                    |
| Compiler writes to SQLite                                                             | Banned — kernel owns all state writes       |
| Compiler writes audit traces                                                          | Banned — kernel traces compilation outcomes |
| `workspace:*` for internal package refs                                               | Required                                    |
| `pnpm audit --audit-level=moderate` in CI                                             | Required gate — blocks merge on findings    |
