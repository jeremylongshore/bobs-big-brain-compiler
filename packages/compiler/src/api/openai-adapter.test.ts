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

  it('strips the MiniMax <think> block that arrives inline in content', async () => {
    process.env['ICO_PROVIDER'] = 'minimax';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          // The EXACT shape observed against the live MiniMax-M3 API on
          // 2026-07-31: chain-of-thought inline in `content`, and
          // `reasoning_content` empty — so the usual fallback never fires.
          choices: [
            {
              message: {
                content:
                  '<think>The user is asking me to reply with only JSON.</think>\n\n{"ok":true}',
                reasoning_content: '',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    const result = await client.createCompletion('s', 'u', { model: 'MiniMax-M3' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The compiler passes parse this as JSON: the think block must be gone
      // AND the leading blank lines trimmed, leaving parseable output.
      expect(result.value.content).toBe('{"ok":true}');
      expect(JSON.parse(result.value.content)).toEqual({ ok: true });
    }
  });

  it('falls through to reasoning_content when content is ONLY a think block', async () => {
    process.env['ICO_PROVIDER'] = 'minimax';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: '<think>still deliberating</think>',
                reasoning_content: 'the actual compiled page',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    const result = await client.createCompletion('s', 'u', { model: 'MiniMax-M3' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stripping happens BEFORE the `||`, so an all-think content correctly
      // yields the reasoning fallback rather than leaking chain-of-thought.
      expect(result.value.content).toBe('the actual compiled page');
    }
  });

  it('drops an UNTERMINATED think block rather than returning truncated reasoning', async () => {
    process.env['ICO_PROVIDER'] = 'minimax';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              // Model hit its token budget mid-thought: no closing tag.
              message: { content: '<think>I should start by checking whe' },
              finish_reason: 'length',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    const result = await client.createCompletion('s', 'u', { model: 'MiniMax-M3' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Truncated reasoning is NOT an answer — better to report nothing than to
      // feed half a thought to a JSON parser.
      expect(result.value.content).toBe('');
    }
  });

  it('leaves non-think content byte-identical for other openai-wire providers', async () => {
    process.env['ICO_PROVIDER'] = 'groq';
    const payload = 'a page that merely mentions <thinking> in prose  ';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: payload }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('k');
    const result = await client.createCompletion('s', 'u', { model: 'llama-3.3-70b-versatile' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // No `<think>` present → returned untouched, trailing whitespace included.
      expect(result.value.content).toBe(payload);
    }
  });

  it('routes minimax to the MiniMax base URL with its own key env', async () => {
    process.env['ICO_PROVIDER'] = 'minimax';
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
    const result = await client.createCompletion('s', 'u', {});

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.minimax.io/v1/chat/completions');
    // Default model comes from the registry, not the caller.
    const body = JSON.parse(init.body as string) as ChatBody;
    expect(body.model).toBe('MiniMax-M3');
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
