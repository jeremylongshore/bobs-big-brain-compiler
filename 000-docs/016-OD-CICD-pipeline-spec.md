# CI/CD Pipeline Upgrade Specification

> From stubs to gates. Every merge proves the code works.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose and Scope

This document specifies the complete transition from stub CI scripts to real quality gates. Every section is actionable: it names the exact file to create or edit, the exact commands to run, and the exact conditions that must pass before a merge is permitted.

The upgrade activates during Epic 2 (Repo Foundation). No decisions are deferred to later epics. After Epic 2, every push to `main` and every open PR is gated by lint, typecheck, test with coverage, build, and dependency audit. No stub echo commands remain in any script.

---

## 2. Current State (Pre-Epic 2)

All four scripts in `package.json` are stubs that exit 0 regardless of code quality:

```json
"build":     "echo 'No build configured yet'",
"test":      "echo 'No tests configured yet'",
"lint":      "echo 'No linter configured yet'",
"typecheck": "echo 'No typecheck configured yet'"
```

The existing `ci.yml` calls these stubs. It technically passes but proves nothing. The existing `release.yml` runs `pnpm test || true`, explicitly tolerating test failures. Both workflows must be replaced in full.

---

## 3. Target State

### 3.1 What changes

| Script      | Before                               | After                                     |
| ----------- | ------------------------------------ | ----------------------------------------- |
| `build`     | `echo 'No build configured yet'`     | `pnpm -r --workspace-concurrency=1 build` |
| `test`      | `echo 'No tests configured yet'`     | `pnpm -r test`                            |
| `lint`      | `echo 'No linter configured yet'`    | `pnpm -r lint`                            |
| `typecheck` | `echo 'No typecheck configured yet'` | `pnpm -r typecheck`                       |

### 3.2 CI gates added

| Gate                   | Blocks Merge | Command                                                    |
| ---------------------- | ------------ | ---------------------------------------------------------- |
| Lint                   | Yes          | `pnpm -r lint`                                             |
| Typecheck              | Yes          | `pnpm -r typecheck`                                        |
| Test + coverage        | Yes          | `pnpm -r test -- --coverage`                               |
| Build                  | Yes          | `pnpm -r --workspace-concurrency=1 build`                  |
| Dependency audit       | Yes          | `pnpm audit --audit-level=high`                            |
| Temp workspace cleanup | No           | `find /tmp -name 'ico-test-*' -mmin +30 -exec rm -rf {} +` |

### 3.3 What does not change

The release workflow's version bump logic, changelog generation, and GitHub Release creation remain unchanged. Only the `Verify readiness` step is upgraded to run real tests and fail hard on test failure.

---

## 4. Package Dependency Graph and Build Order

The four workspace packages have a strict dependency hierarchy. Build, typecheck, and integration tests must respect this order.

```
packages/types/
    ^
    |
packages/kernel/     (depends on: types)
    ^
    |
packages/compiler/   (depends on: types, kernel)
    ^
    |
packages/cli/        (depends on: types, kernel, compiler)
```

**Rule:** `types` has no internal dependencies and always builds first. `kernel` requires compiled `types` declarations. `compiler` requires compiled `types` and `kernel` declarations. `cli` requires all three.

**In CI, build runs with `--workspace-concurrency=1`** to enforce sequential order matching the graph above. pnpm resolves the execution order from the `dependencies` fields in each package's `package.json` — workspace packages that declare `@ico/types: "workspace:*"` will be built after `types` automatically, but only when concurrency is 1. Do not set `--workspace-concurrency` higher than 1 for the build job.

**Lint and typecheck can run in parallel** (`pnpm -r lint`, `pnpm -r typecheck`) because they operate on source files and do not require compiled output from sibling packages.

**Test can run in parallel** at the per-package level once the build is complete. The root `pnpm -r test` command is sufficient; pnpm resolves dependency order.

---

## 5. Per-Package Script Definitions

Each package under `packages/` must define these four scripts. Apply the following `scripts` block to each package's `package.json`.

### 5.1 packages/types/package.json scripts

```json
"scripts": {
  "build":     "tsup src/index.ts --format esm --dts --clean",
  "test":      "vitest run --coverage",
  "lint":      "eslint src --ext .ts",
  "typecheck": "tsc --noEmit"
}
```

### 5.2 packages/kernel/package.json scripts

```json
"scripts": {
  "build":     "tsup src/index.ts --format esm --dts --clean",
  "test":      "vitest run --coverage",
  "lint":      "eslint src --ext .ts",
  "typecheck": "tsc --noEmit"
}
```

### 5.3 packages/compiler/package.json scripts

```json
"scripts": {
  "build":     "tsup src/index.ts --format esm --dts --clean",
  "test":      "vitest run --coverage",
  "lint":      "eslint src --ext .ts",
  "typecheck": "tsc --noEmit"
}
```

### 5.4 packages/cli/package.json scripts

The CLI sets `bundle: true` in its tsup config (produces a self-contained binary). All other scripts are identical.

```json
"scripts": {
  "build":     "tsup src/index.ts --format esm --dts --clean",
  "test":      "vitest run --coverage",
  "lint":      "eslint src --ext .ts",
  "typecheck": "tsc --noEmit"
}
```

---

## 6. Root package.json — Complete Replacement

Replace the entire `scripts` block in the root `package.json` with the following. The `audit:deps` script uses `moderate` per the coding standards (doc 013 section 11). The CI audit job independently uses `high` as the merge gate threshold — this is intentional; `moderate` is for local developer runs and `high` is the hard merge gate.

```json
{
  "name": "intentional-cognition-os",
  "version": "0.1.3",
  "private": true,
  "description": "Local-first, remote-capable knowledge operating system. Compile knowledge for the machine. Distill understanding for the human.",
  "type": "module",
  "packageManager": "pnpm@10.8.1",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "scripts": {
    "build": "pnpm -r --workspace-concurrency=1 build",
    "test": "pnpm -r test",
    "test:coverage": "pnpm -r test -- --coverage",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "audit:deps": "pnpm audit --audit-level=moderate",
    "clean": "pnpm -r exec -- rm -rf dist .tsbuildinfo"
  },
  "author": "Jeremy Longshore",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/jeremylongshore/intentional-cognition-os.git"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^4.0.0",
    "tsup": "^8.0.0",
    "eslint": "^10.0.0",
    "typescript-eslint": "^8.0.0"
  }
}
```

---

## 7. Vitest Coverage Configuration

The root `vitest.config.ts` enforces per-package coverage thresholds. These thresholds are hard gates — Vitest exits non-zero if any threshold is not met, which fails the CI job.

Place this file at the repository root:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['evals/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text', 'json', 'json-summary'],
      // json-summary is required for Codecov upload
      reportsDirectory: './coverage',
      thresholds: {
        'packages/types/src': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/kernel/src': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/compiler/src': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'packages/cli/src': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    environment: 'node',
  },
});
```

---

## 8. Upgraded CI Workflow — Complete .github/workflows/ci.yml

This replaces the existing `ci.yml` in full. Key changes from the current file:

- All stubs are replaced by real commands.
- `install` is factored into a shared job that uploads `node_modules` as an artifact — no repeated `pnpm install --frozen-lockfile` across jobs.
- `lint` and `typecheck` run in parallel after install, with no build dependency.
- `test` depends on `build` completing first (integration tests import compiled package declarations).
- `build` runs sequentially (`--workspace-concurrency=1`) and depends on `typecheck` passing.
- `audit` runs independently of build order.
- Coverage is uploaded to Codecov after test passes.
- Temp workspace cleanup runs as a post-step after test.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  # ------------------------------------------------------------------
  # install
  # Resolves and caches dependencies once. All downstream jobs restore
  # from cache rather than re-running pnpm install.
  # ------------------------------------------------------------------
  install:
    name: Install
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Cache node_modules
        uses: actions/cache/save@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

  # ------------------------------------------------------------------
  # lint
  # Runs ESLint across all packages in parallel (pnpm -r lint).
  # Does not require a prior build — ESLint operates on source files.
  # ------------------------------------------------------------------
  lint:
    name: Lint
    runs-on: ubuntu-latest
    needs: install
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Lint
        # pnpm -r runs the script in every workspace package that defines it.
        # Packages without a lint script are skipped without error.
        run: pnpm -r lint

  # ------------------------------------------------------------------
  # typecheck
  # Runs tsc --noEmit across all packages in parallel (pnpm -r typecheck).
  # Does not require a prior build for the same reason as lint.
  # Each package's tsconfig.json extends the root tsconfig.json which
  # has strict mode fully enabled (see 013-AT-CODE-coding-standards.md).
  # ------------------------------------------------------------------
  typecheck:
    name: Typecheck
    runs-on: ubuntu-latest
    needs: install
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Typecheck
        run: pnpm -r typecheck

  # ------------------------------------------------------------------
  # build
  # Builds all packages sequentially in dependency order using tsup.
  # --workspace-concurrency=1 forces pnpm to respect the workspace
  # dependency graph: types -> kernel -> compiler -> cli.
  # This job must pass before test runs (tests import compiled .d.ts).
  # Depends on typecheck to avoid building known-broken code.
  # ------------------------------------------------------------------
  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [install, typecheck]
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Build (sequential, dependency-ordered)
        # --workspace-concurrency=1 ensures build order:
        # types -> kernel -> compiler -> cli
        # pnpm derives the order from workspace:* declarations in each
        # package's dependencies field.
        run: pnpm -r --workspace-concurrency=1 build

      - name: Cache dist artifacts
        uses: actions/cache/save@v4
        with:
          path: packages/*/dist
          key: dist-${{ runner.os }}-${{ github.sha }}

  # ------------------------------------------------------------------
  # test
  # Runs vitest across all packages with v8 coverage.
  # Depends on build because integration tests import compiled output.
  # Coverage thresholds are enforced by vitest.config.ts:
  #   types: 100%, kernel: 90%, compiler: 80%, cli: 70%
  # Failing a threshold exits non-zero and fails this job.
  # Uploads coverage/coverage-summary.json to Codecov.
  # Post-step cleans up any leaked temp workspaces from crashed tests.
  # ------------------------------------------------------------------
  test:
    name: Test
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Restore dist artifacts
        uses: actions/cache/restore@v4
        with:
          path: packages/*/dist
          key: dist-${{ runner.os }}-${{ github.sha }}

      - name: Test with coverage
        # --coverage activates the v8 provider defined in vitest.config.ts.
        # Coverage thresholds in vitest.config.ts are enforced automatically.
        # pnpm -r runs vitest in each package; root vitest.config.ts provides
        # the aggregate threshold check.
        run: pnpm -r test -- --coverage

      - name: Upload coverage report
        # Upload runs even if coverage thresholds fail (always: true) so
        # reviewers can see what coverage looks like before fixing thresholds.
        if: always()
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/coverage-summary.json
          flags: unittests
          fail_ci_if_error: false
          # CODECOV_TOKEN is optional for public repos but required for private.
          # Add as a repository secret if the repo is private.
          token: ${{ secrets.CODECOV_TOKEN }}

      - name: Clean up leaked temp workspaces
        # Safety net: removes any ico-test-* directories left in /tmp by
        # crashed test processes. Not a substitute for proper afterEach cleanup.
        if: always()
        run: find /tmp -name 'ico-test-*' -mmin +30 -exec rm -rf {} + || true

  # ------------------------------------------------------------------
  # audit
  # Runs pnpm audit at high severity. Blocks merge on any high or
  # critical finding. Does not depend on build — audit reads the
  # lockfile directly.
  # To suppress a known false positive, add the GHSA ID to
  # .pnpmauditignore with a dated justification comment.
  # ------------------------------------------------------------------
  audit:
    name: Dependency Audit
    runs-on: ubuntu-latest
    needs: install
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            packages/*/node_modules
          key: node_modules-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Audit dependencies
        # high threshold: blocks on high and critical, passes on moderate and low.
        # The coding standards doc (013) requires moderate as the local dev
        # threshold. CI uses high to avoid blocking routine PRs on informational
        # advisories while still catching exploitable vulnerabilities.
        run: pnpm audit --audit-level=high
```

---

## 9. Upgraded Release Workflow — Key Changes to .github/workflows/release.yml

The release workflow requires one targeted change: the `Verify readiness` step must run real tests and fail hard rather than tolerating test failures with `|| true`. All other steps remain unchanged.

Replace only the `Verify readiness` step:

```yaml
- name: Verify readiness
  run: |
    echo "--- Checking for uncommitted changes ---"
    if ! git diff --quiet || ! git diff --staged --quiet; then
      echo "::error::Uncommitted changes detected"
      exit 1
    fi
    echo "Working tree is clean."

    echo "--- Running full CI gates before release ---"
    # Build in dependency order before running tests.
    pnpm -r --workspace-concurrency=1 build
    # Run tests with coverage. Exits non-zero if thresholds are not met.
    pnpm -r test -- --coverage
    # Audit for high/critical vulnerabilities.
    pnpm audit --audit-level=high
    echo "All release gates passed."
```

The full `release.yml` file is not reproduced here because all other steps are unchanged. The only line removed is `|| true` from the original test invocation, and the step is expanded to include build and audit as preconditions.

---

## 10. pnpm-workspace.yaml

This file must exist at the repository root before `pnpm -r` commands will discover workspace packages. If it does not exist, create it now:

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
```

---

## 11. Job Dependency Graph

The following diagram shows which CI jobs must complete before others can start. Merge is blocked if any job with a "blocks merge" label fails.

```
install (blocks merge)
    |
    +--------+----------+----------+
    |        |          |          |
  lint    typecheck   audit      (no further deps)
(blocks) (blocks)   (blocks)
             |
           build (blocks merge)
             |
           test (blocks merge)
```

Lint, audit, and typecheck all run in parallel after install. Build waits for typecheck (avoids building code with known type errors). Test waits for build (integration tests need compiled declarations).

The fastest possible path on a cold run: install -> typecheck -> build -> test. Lint and audit run in parallel and do not add to the critical path unless they are the slowest job.

---

## 12. Epic 2 Implementation Checklist

Complete these tasks in the order listed. Each task has a concrete done condition.

1. **Create `pnpm-workspace.yaml`** at repo root. Done when `pnpm -r ls` lists all four packages.

2. **Scaffold `packages/types/`** with `package.json` containing the scripts from section 5.1, a `tsconfig.json` extending root, a `tsup.config.ts`, and a `vitest.config.ts`. Done when `pnpm --filter @ico/types build` exits 0.

3. **Scaffold `packages/kernel/`** with the same structure and scripts from section 5.2. Done when `pnpm --filter @ico/kernel build` exits 0.

4. **Scaffold `packages/compiler/`** with scripts from section 5.3. Done when `pnpm --filter @ico/compiler build` exits 0.

5. **Scaffold `packages/cli/`** with scripts from section 5.4. Done when `pnpm --filter @ico/cli build` exits 0.

6. **Replace root `package.json` scripts** with the block in section 6. Done when `pnpm build` runs tsup for all four packages in order without the echo stub appearing in output.

7. **Create root `vitest.config.ts`** from section 7. Done when `pnpm test:coverage` exits 0 and prints a coverage table.

8. **Replace `.github/workflows/ci.yml`** with the complete file from section 8. Done when a push to a feature branch triggers the workflow and all five jobs pass in GitHub Actions.

9. **Update `.github/workflows/release.yml`** `Verify readiness` step per section 9. Done when a manual dispatch dry run completes without `|| true` in the log.

10. **Verify build order** by inspecting the Actions log for the build job. The tsup output must show `@ico/types` completing before `@ico/kernel`, `@ico/kernel` before `@ico/compiler`, and `@ico/compiler` before `@ico/cli`.

---

## 13. Caching Strategy

| Cache key                        | Contents                                       | Saved by      | Restored by                                   |
| -------------------------------- | ---------------------------------------------- | ------------- | --------------------------------------------- |
| `node_modules-$OS-$lockfileHash` | `node_modules/` and `packages/*/node_modules/` | `install` job | `lint`, `typecheck`, `build`, `test`, `audit` |
| `dist-$OS-$sha`                  | `packages/*/dist/`                             | `build` job   | `test` job only                               |

The lockfile hash in the node_modules cache key invalidates the cache on any `pnpm-lock.yaml` change. The commit SHA in the dist cache key ensures the test job always uses the dist produced by the build job in the same workflow run, never a stale build from a previous commit.

---

## 14. Audit False Positive Suppression

If `pnpm audit --audit-level=high` fails on a known false positive (e.g., a browser-only vulnerability in a Node.js-only dependency), do not lower the audit level. Instead:

1. Add a `.pnpmauditignore` file at the repository root.
2. Add the GHSA ID with a dated justification comment.

```
# .pnpmauditignore
# GHSA-xxxx-xxxx-xxxx — affects browser environments only.
# intentional-cognition-os is a Node.js CLI. Not exploitable.
# Reviewed: 2026-04-06. Re-review if package context changes.
GHSA-xxxx-xxxx-xxxx
```

3. Commit the `.pnpmauditignore` file with a `chore:` commit message documenting the rationale.

---

## 15. Environment Variables Required in CI

| Variable            | Where                  | Required for                                                       |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `CODECOV_TOKEN`     | Repository secret      | Coverage upload (required for private repos, optional for public)  |
| `GITHUB_TOKEN`      | Automatically provided | Release workflow — create tags and GitHub Releases                 |
| `ICO_MODEL`         | Not needed in CI       | Compiler unit tests mock the model client; no real API calls in CI |
| `ANTHROPIC_API_KEY` | Not needed in CI       | Same reason — mocked in unit tests, evals run separately           |

Evals (`evals/`) require `ANTHROPIC_API_KEY` and are explicitly excluded from Vitest. They run via `ico eval run` on-demand or on a scheduled cadence, not in the merge-blocking CI pipeline.
