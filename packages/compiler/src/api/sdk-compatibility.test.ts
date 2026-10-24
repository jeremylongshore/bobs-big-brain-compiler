import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeClient, createClaudeClientFromSdk } from './claude-client.js';

const payload = (content: unknown[]) => ({
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  content,
  usage: { input_tokens: 17, output_tokens: 9 },
  model: 'fixture-returned-model',
  stop_reason: 'end_turn',
  stop_sequence: null,
});

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

beforeEach(() => {
  vi.stubEnv('ICO_PROVIDER', 'anthropic');
  vi.stubEnv('ICO_MODEL', 'fixture-request-model');
  vi.stubEnv('ICO_BASE_URL', 'https://fixture.invalid');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('installed Anthropic SDK request and response contract', () => {
  it('preserves request serialization and extracts the first text after a tool block', async () => {
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          payload([
            { type: 'tool_use', id: 'tool_fixture', name: 'fixture', input: {} },
            { type: 'text', text: 'first text' },
            { type: 'text', text: 'second text' },
          ]),
        ),
      ),
    );
    const client = createClaudeClientFromSdk(
      new Anthropic({
        apiKey: 'synthetic-key',
        baseURL: 'https://fixture.invalid',
        maxRetries: 0,
        fetch,
      }),
    );
    const result = await client.createCompletion('synthetic system', 'synthetic user', {
      model: 'fixture-request-model',
      maxTokens: 23,
      temperature: 0.25,
      timeout: 1200,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        content: 'first text',
        inputTokens: 17,
        outputTokens: 9,
        model: 'fixture-returned-model',
        stopReason: 'end_turn',
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(requestUrl(url)).toBe('https://fixture.invalid/v1/messages');
    expect(init?.method).toBe('POST');
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('Expected a serialized JSON request body');
    expect(JSON.parse(body)).toEqual({
      model: 'fixture-request-model',
      max_tokens: 23,
      temperature: 0.25,
      system: 'synthetic system',
      messages: [{ role: 'user', content: 'synthetic user' }],
    });
  });

  it('preserves empty text and unknown stop reason for a non-text response', async () => {
    const response = {
      ...payload([{ type: 'tool_use', id: 'tool_fixture', name: 'fixture', input: {} }]),
      stop_reason: null,
    };
    const fetch = vi.fn(() => Promise.resolve(Response.json(response)));
    const client = createClaudeClientFromSdk(
      new Anthropic({
        apiKey: 'synthetic-key',
        baseURL: 'https://fixture.invalid',
        maxRetries: 0,
        fetch,
      }),
    );
    const result = await client.createCompletion('synthetic system', 'synthetic user');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('');
      expect(result.value.stopReason).toBe('unknown');
    }
  });

  it('uses the production constructor provider base URL', async () => {
    vi.stubEnv('ICO_PROVIDER', 'anthropic');
    vi.stubEnv('ICO_BASE_URL', 'https://fixture.invalid/custom');
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'synthetic provider failure' },
          },
          { status: 401 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await createClaudeClient('synthetic-key').createCompletion(
      'synthetic system',
      'synthetic user',
      { timeout: 1200 },
    );
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetch.mock.calls[0]![0])).toBe('https://fixture.invalid/custom/v1/messages');
  });
  it('keeps production SDK retries disabled while the wrapper owns five attempts', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ICO_PROVIDER', 'anthropic');
    vi.stubEnv('ICO_BASE_URL', 'https://fixture.invalid');
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { type: 'error', error: { type: 'rate_limit_error', message: 'synthetic failure' } },
          { status: 429 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = createClaudeClient('synthetic-key').createCompletion(
      'synthetic system',
      'synthetic user',
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
