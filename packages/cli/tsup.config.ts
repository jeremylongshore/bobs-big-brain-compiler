import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
  bundle: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // After every build, copy the kernel's SQL migrations next to the CLI
  // dist/index.js. The kernel's `resolveMigrationsDir` checks for
  // `<__dirname>/migrations` as the bundled-layout fallback, so this
  // makes the published tarball self-sufficient — no external workspace
  // dependency needed at runtime.
  onSuccess: () => {
    // 1. Migrations from kernel package, mirrored into dist/migrations
    //    so the bundled-layout runtime fallback finds them.
    const migSrc = resolve(__dirname, '..', 'kernel', 'migrations');
    const migDst = resolve(__dirname, 'dist', 'migrations');
    mkdirSync(migDst, { recursive: true });
    cpSync(migSrc, migDst, { recursive: true });

    // 2. README + LICENSE from the repo root, copied next to package.json
    //    so the npm tarball ships them. package.json's `files: ["dist",
    //    "README.md", "LICENSE"]` references them at the package root.
    //    These files live at the monorepo root (the CLI dir does not
    //    own them), so copy at build time. The copies are gitignored.
    const repoRoot = resolve(__dirname, '..', '..');
    for (const file of ['README.md', 'LICENSE']) {
      copyFileSync(resolve(repoRoot, file), resolve(__dirname, file));
    }
    return Promise.resolve();
  },
  // Externalize:
  //   - native bindings (better-sqlite3)
  //   - CJS deps that use dynamic require/eval at runtime (gray-matter,
  //     pdf-parse, turndown) — bundling them produces ESM that throws
  //     "Dynamic require is not supported" at the first call site.
  //   - large third-party SDKs (@anthropic-ai/sdk) where bundling
  //     duplicates code and slows install.
  //   - js-yaml: pure ESM-friendly but listed for symmetry.
  // The matching runtime entries live in packages/cli/package.json
  // `dependencies` so end users get them installed by npm.
  external: [
    'better-sqlite3',
    '@anthropic-ai/sdk',
    'gray-matter',
    'js-yaml',
    'pdf-parse',
    'turndown',
  ],
});
