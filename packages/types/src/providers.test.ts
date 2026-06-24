import { describe, expect, it } from 'vitest';

import {
  listBuiltinProviders,
  type ProviderEnv,
  providerRequiresKey,
  resolveApiKey,
  resolveModel,
  resolveProvider,
} from './providers.js';

/**
 * The provider registry is the model-agnostic core of the compiler backend.
 * These tests exercise the pure resolution logic with explicit environments —
 * no process.env mutation, no network. They lock the contract that lets any
 * model (Anthropic, OpenAI-compatible, local) be housed via ICO_PROVIDER.
 */
describe('resolveProvider', () => {
  it('defaults to the native Anthropic provider when ICO_PROVIDER is unset', () => {
    const p = resolveProvider({});
    expect(p.id).toBe('anthropic');
    expect(p.wire).toBe('anthropic');
    expect(p.baseURL).toBeNull();
    expect(p.defaultModel).toBe('claude-sonnet-4-6');
    expect(p.keyEnv).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('resolves each OpenAI-wire vendor to its own base URL and key env', () => {
    const groq = resolveProvider({ ICO_PROVIDER: 'groq' });
    expect(groq.wire).toBe('openai');
    expect(groq.baseURL).toBe('https://api.groq.com/openai/v1');
    expect(groq.keyEnv).toEqual(['GROQ_API_KEY']);

    const nvidia = resolveProvider({ ICO_PROVIDER: 'nvidia' });
    expect(nvidia.wire).toBe('openai');
    expect(nvidia.baseURL).toBe('https://integrate.api.nvidia.com/v1');
    expect(nvidia.keyEnv).toEqual(['NVIDIA_API_KEY']);

    const openai = resolveProvider({ ICO_PROVIDER: 'openai' });
    expect(openai.wire).toBe('openai');
    expect(openai.baseURL).toBe('https://api.openai.com/v1');
    expect(openai.keyEnv).toEqual(['OPENAI_API_KEY']);
  });

  it('resolves DeepSeek over both its OpenAI and Anthropic endpoints', () => {
    const ds = resolveProvider({ ICO_PROVIDER: 'deepseek' });
    expect(ds.wire).toBe('openai');
    expect(ds.baseURL).toBe('https://api.deepseek.com');

    const dsa = resolveProvider({ ICO_PROVIDER: 'deepseek-anthropic' });
    expect(dsa.wire).toBe('anthropic');
    expect(dsa.baseURL).toBe('https://api.deepseek.com/anthropic');
  });

  it('is case-insensitive and trims the provider id', () => {
    const p = resolveProvider({ ICO_PROVIDER: '  GroQ  ' });
    expect(p.id).toBe('groq');
  });

  it('maps ollama/vllm/openai-compatible aliases onto the local provider', () => {
    for (const alias of ['ollama', 'vllm', 'openai-compatible']) {
      const p = resolveProvider({ ICO_PROVIDER: alias });
      expect(p.id).toBe('local');
      expect(p.wire).toBe('openai');
      expect(p.baseURL).toBe('http://localhost:11434/v1');
    }
  });

  it('throws a helpful error on an unknown provider id', () => {
    expect(() => resolveProvider({ ICO_PROVIDER: 'definitely-not-real' })).toThrow(
      /Unknown ICO_PROVIDER 'definitely-not-real'/,
    );
  });

  it('lets ICO_BASE_URL override a built-in base URL (and trims trailing slash)', () => {
    const p = resolveProvider({
      ICO_PROVIDER: 'groq',
      ICO_BASE_URL: 'https://proxy.internal/v1/',
    });
    expect(p.baseURL).toBe('https://proxy.internal/v1');
  });

  it('honors the legacy DEEPSEEK_BASE_URL only for the deepseek provider', () => {
    const ds = resolveProvider({
      ICO_PROVIDER: 'deepseek',
      DEEPSEEK_BASE_URL: 'https://mirror.deepseek.test/',
    });
    expect(ds.baseURL).toBe('https://mirror.deepseek.test');

    // For a different provider, DEEPSEEK_BASE_URL is ignored.
    const groq = resolveProvider({
      ICO_PROVIDER: 'groq',
      DEEPSEEK_BASE_URL: 'https://mirror.deepseek.test/',
    });
    expect(groq.baseURL).toBe('https://api.groq.com/openai/v1');
  });

  it('lets ICO_BASE_URL take precedence over the legacy DEEPSEEK_BASE_URL', () => {
    const ds = resolveProvider({
      ICO_PROVIDER: 'deepseek',
      ICO_BASE_URL: 'https://primary.test',
      DEEPSEEK_BASE_URL: 'https://legacy.test',
    });
    expect(ds.baseURL).toBe('https://primary.test');
  });

  it('lets ICO_PROVIDER_WIRE flip the adapter for a built-in slot', () => {
    // A vendor reusing the openai slot but speaking the anthropic wire.
    const p = resolveProvider({ ICO_PROVIDER: 'openai', ICO_PROVIDER_WIRE: 'anthropic' });
    expect(p.wire).toBe('anthropic');
  });

  describe('custom provider', () => {
    it('builds a fully custom provider from env', () => {
      const env: ProviderEnv = {
        ICO_PROVIDER: 'custom',
        ICO_PROVIDER_WIRE: 'openai',
        ICO_BASE_URL: 'https://my-gateway.example/v1/',
        ICO_MODEL: 'house-model-7b',
      };
      const p = resolveProvider(env);
      expect(p.id).toBe('custom');
      expect(p.wire).toBe('openai');
      expect(p.baseURL).toBe('https://my-gateway.example/v1');
      expect(p.defaultModel).toBe('house-model-7b');
    });

    it('throws when custom is missing the wire format', () => {
      expect(() =>
        resolveProvider({ ICO_PROVIDER: 'custom', ICO_BASE_URL: 'https://x.test' }),
      ).toThrow(/ICO_PROVIDER_WIRE/);
    });

    it('throws when custom is missing the base URL', () => {
      expect(() =>
        resolveProvider({ ICO_PROVIDER: 'custom', ICO_PROVIDER_WIRE: 'openai' }),
      ).toThrow(/ICO_BASE_URL/);
    });

    it('rejects an invalid wire value for custom', () => {
      expect(() =>
        resolveProvider({
          ICO_PROVIDER: 'custom',
          ICO_PROVIDER_WIRE: 'grpc',
          ICO_BASE_URL: 'https://x.test',
        }),
      ).toThrow(/ICO_PROVIDER_WIRE/);
    });
  });
});

describe('resolveApiKey', () => {
  it('reads the provider-specific key env', () => {
    const p = resolveProvider({ ICO_PROVIDER: 'groq' });
    expect(resolveApiKey(p, { GROQ_API_KEY: 'gsk-abc' })).toBe('gsk-abc');
  });

  it('prefers the generic ICO_API_KEY over the provider-specific env', () => {
    const p = resolveProvider({ ICO_PROVIDER: 'anthropic' });
    const key = resolveApiKey(p, { ICO_API_KEY: 'generic', ANTHROPIC_API_KEY: 'specific' });
    expect(key).toBe('generic');
  });

  it('trims whitespace and treats a blank value as absent', () => {
    const p = resolveProvider({ ICO_PROVIDER: 'anthropic' });
    expect(resolveApiKey(p, { ANTHROPIC_API_KEY: '  sk-ant-real  ' })).toBe('sk-ant-real');
    expect(resolveApiKey(p, { ANTHROPIC_API_KEY: '   ' })).toBe('');
  });

  it('returns empty string when no key is present', () => {
    const p = resolveProvider({ ICO_PROVIDER: 'local' });
    expect(resolveApiKey(p, {})).toBe('');
  });
});

describe('providerRequiresKey', () => {
  it('requires a key for any provider with a named key env', () => {
    expect(providerRequiresKey(resolveProvider({ ICO_PROVIDER: 'anthropic' }))).toBe(true);
    expect(providerRequiresKey(resolveProvider({ ICO_PROVIDER: 'groq' }))).toBe(true);
  });

  it('does not require a key for a localhost server', () => {
    expect(providerRequiresKey(resolveProvider({ ICO_PROVIDER: 'local' }))).toBe(false);
  });

  it('requires a key for a keyless provider pointed at a remote endpoint', () => {
    const p = resolveProvider({
      ICO_PROVIDER: 'custom',
      ICO_PROVIDER_WIRE: 'openai',
      ICO_BASE_URL: 'https://remote-gateway.example/v1',
    });
    expect(providerRequiresKey(p)).toBe(true);
  });

  it('does not require a key for a custom provider pointed at 127.0.0.1', () => {
    const p = resolveProvider({
      ICO_PROVIDER: 'custom',
      ICO_PROVIDER_WIRE: 'openai',
      ICO_BASE_URL: 'http://127.0.0.1:8000/v1',
    });
    expect(providerRequiresKey(p)).toBe(false);
  });
});

describe('resolveModel', () => {
  it('uses the provider default when ICO_MODEL is unset', () => {
    expect(resolveModel(resolveProvider({ ICO_PROVIDER: 'groq' }), {})).toBe(
      'llama-3.3-70b-versatile',
    );
    expect(resolveModel(resolveProvider({}), {})).toBe('claude-sonnet-4-6');
  });

  it('lets ICO_MODEL override the provider default', () => {
    const p = resolveProvider({ ICO_PROVIDER: 'groq' });
    expect(resolveModel(p, { ICO_MODEL: 'mixtral-8x7b' })).toBe('mixtral-8x7b');
  });

  it('honors the legacy DEEPSEEK_MODEL only for DeepSeek providers', () => {
    const ds = resolveProvider({ ICO_PROVIDER: 'deepseek' });
    expect(resolveModel(ds, { DEEPSEEK_MODEL: 'deepseek-reasoner' })).toBe('deepseek-reasoner');

    // ICO_MODEL still wins over the legacy var.
    expect(resolveModel(ds, { ICO_MODEL: 'deepseek-chat', DEEPSEEK_MODEL: 'x' })).toBe(
      'deepseek-chat',
    );

    // Legacy var is ignored for non-DeepSeek providers.
    const groq = resolveProvider({ ICO_PROVIDER: 'groq' });
    expect(resolveModel(groq, { DEEPSEEK_MODEL: 'deepseek-reasoner' })).toBe(
      'llama-3.3-70b-versatile',
    );
  });
});

describe('listBuiltinProviders', () => {
  it('enumerates the built-in providers (no custom, no aliases)', () => {
    const ids = listBuiltinProviders();
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('groq');
    expect(ids).toContain('nvidia');
    expect(ids).toContain('deepseek');
    expect(ids).toContain('deepseek-anthropic');
    expect(ids).toContain('local');
    expect(ids).not.toContain('custom');
    expect(ids).not.toContain('ollama');
  });
});
