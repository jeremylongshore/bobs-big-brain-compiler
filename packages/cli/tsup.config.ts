import { cpSync, mkdirSync } from 'node:fs';
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
    const src = resolve(__dirname, '..', 'kernel', 'migrations');
    const dst = resolve(__dirname, 'dist', 'migrations');
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
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
