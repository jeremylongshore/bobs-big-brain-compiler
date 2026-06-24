import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, redactSecrets } from './config.js';

describe('loadConfig', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = join(tmpdir(), `ico-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // Clear relevant env vars
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['DEEPSEEK_API_KEY'];
    delete process.env['GROQ_API_KEY'];
    delete process.env['ICO_PROVIDER'];
    delete process.env['ICO_PROVIDER_WIRE'];
    delete process.env['ICO_BASE_URL'];
    delete process.env['ICO_API_KEY'];
    delete process.env['ICO_WORKSPACE'];
    delete process.env['ICO_MODEL'];
    delete process.env['ICO_RESEARCH_MODEL'];
    delete process.env['ICO_LOG_LEVEL'];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // Restore env
    process.env = { ...originalEnv };
  });

  it('loads config from .env file', () => {
    writeFileSync(join(tempDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key-123\n');
    const config = loadConfig(tempDir);
    expect(config.apiKey).toBe('sk-ant-test-key-123');
    expect(config.workspace).toBe('./workspace');
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.researchModel).toBe('claude-opus-4-6');
    expect(config.logLevel).toBe('info');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() => loadConfig(tempDir)).toThrow('ANTHROPIC_API_KEY is required');
  });

  it('selects a non-Anthropic provider with its own key and default model', () => {
    writeFileSync(join(tempDir, '.env'), 'ICO_PROVIDER=groq\nGROQ_API_KEY=gsk-xyz\n');
    const config = loadConfig(tempDir);
    expect(config.provider).toBe('groq');
    expect(config.apiKey).toBe('gsk-xyz');
    // The model + research model fall back to the provider's default, not Claude.
    expect(config.model).toBe('llama-3.3-70b-versatile');
    expect(config.researchModel).toBe('llama-3.3-70b-versatile');
  });

  it('reports the provider-specific key requirement when its key is missing', () => {
    writeFileSync(join(tempDir, '.env'), 'ICO_PROVIDER=deepseek\n');
    expect(() => loadConfig(tempDir)).toThrow(/DEEPSEEK_API_KEY is required/);
  });

  it('accepts the generic ICO_API_KEY for any provider', () => {
    writeFileSync(join(tempDir, '.env'), 'ICO_PROVIDER=nvidia\nICO_API_KEY=nvapi-generic\n');
    const config = loadConfig(tempDir);
    expect(config.provider).toBe('nvidia');
    expect(config.apiKey).toBe('nvapi-generic');
  });

  it('loads a keyless local provider without throwing', () => {
    writeFileSync(join(tempDir, '.env'), 'ICO_PROVIDER=local\n');
    const config = loadConfig(tempDir);
    expect(config.provider).toBe('local');
    expect(config.apiKey).toBe('');
    expect(config.model).toBe('llama3.1');
  });

  it('throws on an unknown provider id', () => {
    writeFileSync(join(tempDir, '.env'), 'ICO_PROVIDER=not-a-provider\nICO_API_KEY=x\n');
    expect(() => loadConfig(tempDir)).toThrow(/Unknown ICO_PROVIDER/);
  });

  it('ICO_MODEL overrides the provider default model', () => {
    writeFileSync(
      join(tempDir, '.env'),
      'ICO_PROVIDER=groq\nGROQ_API_KEY=gsk\nICO_MODEL=mixtral-8x7b\n',
    );
    const config = loadConfig(tempDir);
    expect(config.model).toBe('mixtral-8x7b');
  });

  it('env vars override .env file', () => {
    writeFileSync(
      join(tempDir, '.env'),
      'ANTHROPIC_API_KEY=file-key\nICO_MODEL=claude-haiku-4-5\n',
    );
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    process.env['ICO_MODEL'] = 'claude-opus-4-6';
    const config = loadConfig(tempDir);
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('claude-opus-4-6');
  });

  it('API key is non-enumerable (not in JSON.stringify)', () => {
    writeFileSync(join(tempDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret\n');
    const config = loadConfig(tempDir);
    const json = JSON.stringify(config);
    expect(json).not.toContain('sk-ant-secret');
    expect(json).not.toContain('apiKey');
    // But it's still accessible directly
    expect(config.apiKey).toBe('sk-ant-secret');
  });

  it('respects custom config values', () => {
    writeFileSync(
      join(tempDir, '.env'),
      ['ANTHROPIC_API_KEY=sk-test', 'ICO_WORKSPACE=/custom/path', 'ICO_LOG_LEVEL=debug'].join('\n'),
    );
    const config = loadConfig(tempDir);
    expect(config.workspace).toBe('/custom/path');
    expect(config.logLevel).toBe('debug');
  });
});

describe('redactSecrets', () => {
  it('redacts known secret field names', () => {
    const input = { apiKey: 'sk-ant-api03-xxxx', name: 'test' };
    const result = redactSecrets(input);
    expect(result['apiKey']).toBe('[REDACTED]');
    expect(result['name']).toBe('test');
  });

  it('redacts values matching secret patterns', () => {
    const input = { someField: 'sk-ant-api03-real-key', other: 'safe' };
    const result = redactSecrets(input);
    expect(result['someField']).toBe('[REDACTED]');
    expect(result['other']).toBe('safe');
  });

  it('redacts Bearer tokens', () => {
    const input = { header: 'Bearer eyJhbGciOiJIUzI1NiJ9' };
    const result = redactSecrets(input);
    expect(result['header']).toBe('[REDACTED]');
  });

  it('recursively redacts nested objects', () => {
    const input = { nested: { apiKey: 'secret', safe: 'value' } };
    const result = redactSecrets(input);
    const nested = result['nested'] as Record<string, unknown>;
    expect(nested['apiKey']).toBe('[REDACTED]');
    expect(nested['safe']).toBe('value');
  });

  it('preserves non-secret values', () => {
    const input = { name: 'test', count: 42, active: true };
    const result = redactSecrets(input);
    expect(result).toEqual(input);
  });
});
