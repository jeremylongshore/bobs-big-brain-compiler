import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeClient } from './claude-client.js';

/**
 * Tests the DeepSeek (OpenAI-compatible) provider path of createClaudeClient,
 * selected via ICO_PROVIDER=deepseek. fetch is mocked — no real network.
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

describe('createClaudeClient — DeepSeek provider', () => {
  const realFetch = globalThis.fetch;
  const realProvider = process.env['ICO_PROVIDER'];

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realProvider === undefined) delete process.env['ICO_PROVIDER'];
    else process.env['ICO_PROVIDER'] = realProvider;
    vi.restoreAllMocks();
  });

  it('routes to DeepSeek and maps the OpenAI response onto CompletionResult', async () => {
    process.env['ICO_PROVIDER'] = 'deepseek';
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'hello from deepseek' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
          model: 'deepseek-v4-flash',
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createClaudeClient('test-deepseek-key');
    const result = await client.createCompletion('be terse', 'say hi', {
      model: 'deepseek-v4-flash',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('hello from deepseek');
      expect(result.value.inputTokens).toBe(11);
      expect(result.value.outputTokens).toBe(4);
      expect(result.value.model).toBe('deepseek-v4-flash');
      expect(result.value.stopReason).toBe('stop');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-deepseek-key' });
    const body = JSON.parse(init.body as string) as ChatBody;
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'say hi' },
    ]);
  });

  it('falls back to the default deepseek-chat when handed an Anthropic model name', async () => {
    process.env['ICO_PROVIDER'] = 'deepseek';
    const prevModel = process.env['DEEPSEEK_MODEL'];
    delete process.env['DEEPSEEK_MODEL'];
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
    await client.createCompletion('s', 'u', { model: 'claude-sonnet-4-6' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as ChatBody;
    // Default must be a PLAIN chat model, not a reasoning model — a reasoning
    // model returns empty `content` and compiles 0 pages (bead ...-dad).
    expect(body.model).toBe('deepseek-chat');
    if (prevModel === undefined) delete process.env['DEEPSEEK_MODEL'];
    else process.env['DEEPSEEK_MODEL'] = prevModel;
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

  it('returns a sanitized error (no key leakage) on a non-ok response', async () => {
    process.env['ICO_PROVIDER'] = 'deepseek';
    globalThis.fetch = (() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch;

    const client = createClaudeClient('secret-key');
    const result = await client.createCompletion('s', 'u');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('authentication_error');
      expect(result.error.message).not.toContain('secret-key');
    }
  });
});
