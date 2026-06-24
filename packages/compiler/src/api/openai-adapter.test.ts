import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeClient } from './claude-client.js';

/**
 * Tests the OpenAI-compatible provider path of createClaudeClient, selected via
 * ICO_PROVIDER (any openai-wire provider: deepseek, groq, openai, nvidia, local).
 * fetch is mocked — no real network. These lock the model-agnostic behavior:
 * one adapter serves every OpenAI-wire vendor, routed by the provider registry.
 */
interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Snapshot + restore the provider-selection env vars around each test. */
const ENV_KEYS = ['ICO_PROVIDER', 'ICO_MODEL', 'ICO_BASE_URL', 'ICO_API_KEY', 'DEEPSEEK_MODEL'];

describe('createClaudeClient — OpenAI-compatible providers', () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('routes DeepSeek and maps the OpenAI response onto CompletionResult', async () => {
    process.env['ICO_PROVIDER'] = 'deepseek';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'hello from deepseek' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
          model: 'deepseek-chat',
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('test-deepseek-key');
    const result = await client.createCompletion('be terse', 'say hi', {
      model: 'deepseek-chat',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('hello from deepseek');
      expect(result.value.inputTokens).toBe(11);
      expect(result.value.outputTokens).toBe(4);
      expect(result.value.model).toBe('deepseek-chat');
      expect(result.value.stopReason).toBe('stop');
    }

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-deepseek-key' });
    const body = JSON.parse(init.body as string) as ChatBody;
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'say hi' },
    ]);
  });

  it('routes Groq to its own base URL with its own key', async () => {
    process.env['ICO_PROVIDER'] = 'groq';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'from groq' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
          model: 'llama-3.3-70b-versatile',
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('gsk-key');
    const result = await client.createCompletion('s', 'u');

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer gsk-key' });
    // No model option + no ICO_MODEL => the provider default model is sent.
    const body = JSON.parse(init.body as string) as ChatBody;
    expect(body.model).toBe('llama-3.3-70b-versatile');
  });

  it('substitutes the provider default when handed an Anthropic model name', async () => {
    process.env['ICO_PROVIDER'] = 'groq';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    // An Anthropic model name is meaningless to Groq; the adapter must swap it
    // for the provider default rather than forward a model Groq can't serve.
    await client.createCompletion('s', 'u', { model: 'claude-sonnet-4-6' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as ChatBody;
    expect(body.model).toBe('llama-3.3-70b-versatile');
  });

  it('honors ICO_BASE_URL to point a provider at a local/proxy endpoint', async () => {
    process.env['ICO_PROVIDER'] = 'openai';
    process.env['ICO_BASE_URL'] = 'http://localhost:1234/v1';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'local' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    await client.createCompletion('s', 'u');

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('omits the Authorization header for a keyless local server', async () => {
    process.env['ICO_PROVIDER'] = 'local';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'local-keyless' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient(''); // no key — local server
    const result = await client.createCompletion('s', 'u');

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('reads reasoning_content when a reasoning model leaves content empty', async () => {
    process.env['ICO_PROVIDER'] = 'deepseek';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          // A reasoning model: empty content, output in reasoning_content.
          choices: [
            {
              message: { content: '', reasoning_content: 'the actual compiled page' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    const result = await client.createCompletion('s', 'u', { model: 'deepseek-reasoner' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Not the empty string — the reasoning_content fallback kicked in.
      expect(result.value.content).toBe('the actual compiled page');
    }
  });

  it('labels the sanitized error with the provider and never leaks the key', async () => {
    process.env['ICO_PROVIDER'] = 'groq';
    globalThis.fetch = (() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch;

    const client = createClaudeClient('secret-key');
    const result = await client.createCompletion('s', 'u');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('authentication_error');
      expect(result.error.message).toContain('Groq');
      expect(result.error.message).not.toContain('secret-key');
    }
  });
});
