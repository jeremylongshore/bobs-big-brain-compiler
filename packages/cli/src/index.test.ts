import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildProgram, cliVersion } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/index.js lives at packages/cli/dist/index.js (one level up from src/)
const distIndex = join(__dirname, '..', 'dist', 'index.js');

const ALL_COMMANDS = [
  'init',
  'ingest',
  'mount',
  'compile',
  'ask',
  'research',
  'render',
  'lint',
  'recall',
  'promote',
  'status',
  'eval',
  'inspect',
] as const;

describe('cli program structure', () => {
  it('registers all expected commands', () => {
    const p = buildProgram();
    const registered = p.commands.map((c) => c.name());
    for (const name of ALL_COMMANDS) {
      expect(registered).toContain(name);
    }
  });

  it('has all global options in help output', () => {
    const p = buildProgram();
    const helpText = p.helpInformation();
    expect(helpText).toContain('--workspace');
    expect(helpText).toContain('--verbose');
    expect(helpText).toContain('--quiet');
    expect(helpText).toContain('--json');
  });

  it('all command names appear in help output', () => {
    const p = buildProgram();
    const helpText = p.helpInformation();
    for (const name of ALL_COMMANDS) {
      expect(helpText).toContain(name);
    }
  });

  it('outputs the version string from the CLI package.json', () => {
    const p = buildProgram();
    p.exitOverride();
    let output = '';
    p.configureOutput({
      writeOut: (str) => {
        output += str;
      },
    });
    try {
      p.parse(['node', 'ico', '--version']);
    } catch {
      // exitOverride causes Commander to throw instead of calling process.exit
    }
    expect(output.trim()).toBe(cliVersion);
  });

  it('help text contains the program description', () => {
    const p = buildProgram();
    const helpText = p.helpInformation();
    expect(helpText).toContain('ico');
    expect(helpText).toContain('Compile knowledge for the machine');
  });
});

describe('cli version', () => {
  it('cliVersion is a semver string read from the CLI package.json', () => {
    expect(typeof cliVersion).toBe('string');
    // Strict semver, optional pre-release tag (e.g. "1.0.0-beta.1").
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });
});

describe('stub command exit codes', () => {
  function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [distIndex, ...args], {
        encoding: 'utf8',
        timeout: 5000,
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        status: e.status ?? 1,
      };
    }
  }

  it('ico --help exits 0 and lists all commands', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    for (const name of ALL_COMMANDS) {
      expect(result.stdout).toContain(name);
    }
  });

  it('ico --version exits 0 and outputs version', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(cliVersion);
  });

  it('ico compile shows help with subcommands', () => {
    const result = runCli(['compile', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sources');
    expect(result.stdout).toContain('all');
  });

  it('ico ask exits 1 without a workspace configured', () => {
    // ask is implemented (E7-B05); without a workspace it exits 1 with a workspace error.
    const result = runCli(['ask', 'what is knowledge?']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workspace');
  });

  it('ico research exits 1 without a valid workspace', () => {
    const result = runCli(['research', 'brief']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No workspace found');
  });

  it('ico render report exits 1 without --topic or --task', () => {
    // render is implemented (E8-B03); without --topic or --task it exits 1 with a usage error.
    const result = runCli(['render', 'report']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required');
  });

  it('ico lint exits 1 without a valid workspace database', () => {
    // lint is implemented (E7-B10); without a workspace database it exits 1.
    const result = runCli(['lint']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('database');
  });

  it('ico recall generate is wired up and requires --topic', () => {
    // E9-B08 wired up `ico recall generate --topic <name>`. Without --topic,
    // Commander exits non-zero with a "required option" usage error.
    const result = runCli(['recall', 'generate']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/required option|--topic/i);
  });

  it('ico promote exits non-zero without --as flag', () => {
    // promote is implemented (E8-B05); without --as it exits non-zero with a usage error.
    const result = runCli(['promote', 'some/path']);
    expect(result.status).not.toBe(0);
    // Commander's requiredOption emits an error when --as is missing
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('ico eval run is registered as a subcommand (E10-B01)', () => {
    // `ico eval --help` should list the `run` subcommand. Without a
    // workspace, `ico eval run` itself exits non-zero with a workspace
    // error, which is enough to prove the wiring.
    const result = runCli(['eval', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run');
  });
});
