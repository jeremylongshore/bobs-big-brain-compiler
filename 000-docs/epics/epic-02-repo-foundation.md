# Epic 2: Repo Foundation, Packages, and Local Runtime Skeleton

**Objective:** Create the real monorepo/package baseline. After this epic, the repo has real TypeScript packages that build, lint, typecheck, and test (even if tests are trivial). The stub scripts are gone.

**Why it exists:** Every implementation epic needs real packages to write code in. Without build tooling, linting, testing, and a package structure, no code can ship with confidence.

**What it unlocks:** Epics 3-10 (all implementation work)

**Dependencies:** Epic 1

**Phase:** 1

---

## Scope

### Included

- pnpm workspace configuration
- Four packages: types, kernel, cli, compiler
- ESLint flat config with typescript-eslint
- Vitest with coverage reporting
- tsup build configuration with build order
- Test fixture workspace scaffolding
- CI pipeline upgrade from stubs to real tools
- Configuration loading (.env)
- Structured logger implementation

### Excluded

- Any application logic (that's Epic 3+)
- Real CLI commands beyond --version and --help (Epic 4)
- Database initialization (Epic 3)

---

## Beads

### E2-B01: pnpm Workspace Configuration and Root Package Updates

- **Depends on:** E1-B05, E1-B08
- **Produces:** `pnpm-workspace.yaml`, updated root `package.json`, root `tsconfig.json`
- **Verification:** `pnpm install` succeeds. `pnpm -r list` shows all packages. Root tsconfig.json valid.

### E2-B02: Kernel Package Scaffold

- **Depends on:** E2-B01
- **Produces:** `packages/kernel/` with package.json (@ico/kernel), tsconfig.json, tsup.config.ts, src/index.ts, placeholder test
- **Verification:** `pnpm --filter @ico/kernel build` produces dist/. Test passes. Typecheck passes.

### E2-B03: CLI Package Scaffold

- **Depends on:** E2-B01, E2-B02
- **Produces:** `packages/cli/` with package.json (@ico/cli), bin field, Commander.js minimal program, placeholder test
- **Verification:** Build succeeds. `ico --version` outputs version. `ico --help` shows program name. Test passes.

### E2-B04: Compiler Package Scaffold

- **Depends on:** E2-B01, E2-B02
- **Produces:** `packages/compiler/` with package.json (@ico/compiler), tsconfig.json, tsup.config.ts, src/index.ts, placeholder test
- **Verification:** Build succeeds. Typecheck passes. Test passes.

### E2-B05: Shared Types Package

- **Depends on:** E2-B01, E1-B01, E1-B02, E1-B03
- **Produces:** `packages/types/` with TypeScript interfaces (Source, Mount, CompiledPage, Task, Promotion, TraceEvent, RecallResult, EntityType) and Zod schemas. EntityType interface covers entity pages (wiki/entities/) — defines slug, label, source citations, and related concepts (audit C4).
- **Verification:** All interfaces compile. Zod schemas validate example data. No circular dependencies. EntityType schema validates example entity page data.

### E2-B06: ESLint Configuration

- **Depends on:** E2-B01 through E2-B04
- **Produces:** `eslint.config.js` with typescript-eslint, strict type-checking, import ordering
- **Verification:** `pnpm lint` runs ESLint across all packages. Zero lint errors. No longer a stub.

### E2-B07: Vitest Configuration

- **Depends on:** E2-B02 through E2-B05
- **Produces:** `vitest.config.ts`, updated test scripts, coverage reporting
- **Verification:** `pnpm test` runs vitest with pass/fail and coverage. No longer a stub.

### E2-B08: tsup Build Configuration and Build Order

- **Depends on:** E2-B02 through E2-B05
- **Produces:** Working build pipeline. Build order: types → kernel → compiler → cli
- **Verification:** `pnpm build` succeeds. Each dist/ has .js and .d.ts files. No longer a stub.

### E2-B09: Test Fixture Workspace Scaffolding

- **Depends on:** E1-B02, E1-B04, E1-B07
- **Produces:** `tests/fixtures/` with TWO fixture sets: (1) **populated** — sample workspace with 3 source files and pre-initialized SQLite database; (2) **empty** — initialized workspace structure (directories, empty SQLite with schema, index.md, log.md) but zero sources, for empty-workspace edge case testing (audit M6).
- **Verification:** Populated fixture matches E1-B04 layout. SQLite database opens with all tables. Sources are realistic (100+ words). Empty fixture has valid directory tree and schema but zero rows in sources/mounts/compilations tables.

### E2-B10: CI Pipeline Upgrade to Real Tooling

- **Depends on:** E2-B06, E2-B07, E2-B08
- **Produces:** Updated `.github/workflows/ci.yml` with real lint, typecheck, test, build. Add `pnpm audit --audit-level=high` as CI gate step — fails pipeline on high/critical vulnerabilities (audit H3). Add `.env` staging check step that fails if any `.env` file (not `.env.example`) is staged for commit (audit L1).
- **Verification:** CI passes on scaffold code. Intentional lint error proves gate works. `pnpm audit` gate runs and passes. Staged `.env` file fails the check.

### E2-B11: .env.example and Configuration Loading

- **Depends on:** E2-B02
- **Produces:** `.env.example`, `packages/kernel/src/config.ts` with loadConfig() and unit tests. Include `redactSecrets()` utility that scrubs known secret field names (API keys, tokens, passwords) before any serialization (audit C2). The loaded API key property must be non-enumerable and non-serializable — `JSON.stringify(config)` must not include the key.
- **Verification:** Typed config returned. Missing ANTHROPIC_API_KEY throws clear error. Defaults work. `JSON.stringify(config)` does not contain the API key. `redactSecrets({apiKey: 'sk-...'})` returns object with apiKey replaced by '[REDACTED]'.

### E2-B12: Structured Logger Implementation

- **Depends on:** E2-B02, E1-B05
- **Produces:** `packages/kernel/src/logger.ts` with Logger class and unit tests. Implement automatic redaction of API key patterns (sk-ant-_, sk-_, Bearer tokens) in all log output — any string matching known secret patterns is replaced with '[REDACTED]' before writing (audit C2).
- **Verification:** Correct format at each level. Quiet/verbose modes work. Tests cover all levels. Logging a string containing 'sk-ant-api03-xxxx' outputs '[REDACTED]' instead of the key.

---

## Exit Criteria

1. All four packages build, lint, typecheck, and test successfully
2. `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck` are real commands, not stubs
3. CI pipeline runs real quality gates and passes
4. `ico --version` and `ico --help` work from the built CLI
5. Test fixture workspace exists with sample data
6. Configuration loading works with .env
7. Structured logger available to all packages
8. `pnpm audit` passes with zero high/critical vulnerabilities

---

## Risks / Watch Items

- **pnpm workspace + TypeScript project references** can be tricky. Mitigation: test cross-package imports early.
- **tsup and vitest config interactions:** ensure both use same TypeScript settings. Mitigation: share a base tsconfig.
- **Build order matters:** CI must build types → kernel → compiler → cli. Mitigation: E2-B08 explicitly defines this.
