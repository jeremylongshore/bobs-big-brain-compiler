// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // --- Global ignores ---
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.beads/**', '**/coverage/**', '**/*.d.ts'],
  },

  // --- Base JS recommended (applies to all non-ignored files) ---
  js.configs.recommended,

  // --- TypeScript with type-checking — scoped to .ts files only ---
  {
    files: ['**/*.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Import ordering ---
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            // Node built-ins (node: protocol first)
            ['^node:'],
            // External packages
            ['^@?\\w'],
            // Internal workspace packages (@ico/*)
            ['^@ico/'],
            // Relative imports
            ['^\\.'],
          ],
        },
      ],
      // Export sort is off — re-export grouping in index files is intentional
      // and organising by source module is more readable than alpha order.
      'simple-import-sort/exports': 'off',

      // --- TypeScript-specific rules ---
      // Enforce import type for type-only imports (verbatimModuleSyntax handles this at tsc level,
      // but ESLint rule provides editor feedback earlier)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],

      // Ban `any` — useUnknownInCatchVariables is on at tsc level too
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused vars — mirror the tsc noUnusedLocals/noUnusedParameters flags
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Prefer consistent return types in async functions
      '@typescript-eslint/no-floating-promises': 'error',

      // Allow void operator to explicitly discard promises
      'no-void': ['error', { allowAsStatement: true }],

      // Turn off the base rule — the TS-aware version handles this correctly
      'no-unused-vars': 'off',
    },
  },

  // --- Looser rules for test files ---
  {
    files: ['**/*.test.ts'],
    rules: {
      // Test utilities often call floating promises intentionally
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // --- .mjs Node scripts (e.g., integration-test workers) ---
  // Node globals (process, console, Buffer, etc.) need explicit declaration
  // under ESLint 10+ which removed legacy `/* eslint-env node */` support.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
