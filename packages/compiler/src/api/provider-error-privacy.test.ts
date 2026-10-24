import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ClaudeClient,
  createClaudeClient,
  createClaudeClientFromSdk,
} from './claude-client.js';

const KEY = 'fixture-key-canary';
const PROMPT = 'fixture-prompt-canary';
const BODY = 'fixture-response-body-canary';
const HEADER = 'fixture-header-canary';
const REQUEST_ID = 'fixture-request-id-canary';

function rejectedResponse(status: number, message = [KEY, PROMPT, BODY].join(':')): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'fixture', message } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': REQUEST_ID,
      'x-fixture': HEADER,
    },
  });
}

function acceptedResponse(compatible = false): Response {
  return Response.json(
    compatible
      ? {
          choices: [{ message: { content: 'accepted' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
          model: 'fixture-model',
        }
      : {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'accepted' }],
          usage: { input_tokens: 2, output_tokens: 1 },
          model: 'fixture-model',
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
  );
}

function sdkClient(fetch: typeof globalThis.fetch): ClaudeClient {
  return createClaudeClientFromSdk(
    new Anthropic({ apiKey: KEY, baseURL: 'https://fixture.invalid', maxRetries: 0, fetch }),
  );
}

function errorFrom(result: Awaited<ReturnType<ClaudeClient['createCompletion']>>): Error {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected the synthetic request to fail');
  return result.error;
}

function expectPrivate(error: Error): void {
  const exposed = [error.message, error.stack, String(error), JSON.stringify(error)].join('\n');
  for (const canary of [KEY, PROMPT, BODY, HEADER, REQUEST_ID]) {
    expect(exposed).not.toContain(canary);
  }
  expect(error).not.toHaveProperty('headers');
  expect(error).not.toHaveProperty('requestID');
  expect(error).not.toHaveProperty('cause');
}

async function finishRetries(client: ClaudeClient) {
  const pending = client.createCompletion('synthetic system', PROMPT);
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  vi.stubEnv('ICO_PROVIDER', 'anthropic');
  vi.stubEnv('ICO_MODEL', 'fixture-model');
  vi.stubEnv('ICO_BASE_URL', 'https://fixture.invalid');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('provider errors keep response data outside the returned Error', () => {
  it('sanitizes a real SDK authentication error without retaining its response data', async () => {
    const fetch = vi.fn(() => Promise.resolve(rejectedResponse(401)));
    const error = errorFrom(await sdkClient(fetch).createCompletion('synthetic system', PROMPT));
    expectPrivate(error);
    expect(error.message).toBe('Claude API authentication_error (HTTP 401)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'bad_request_error'],
    [401, 'authentication_error'],
    [403, 'api_error'],
    [500, 'server_error'],
  ])('does not let SDK HTTP%s response text authorize a retry', async (status, category) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn(() => Promise.resolve(acceptedResponse()))
      .mockImplementationOnce(() =>
        Promise.resolve(
          rejectedResponse(Number(status), `${BODY}: rate_limit_error overloaded_error`),
        ),
      );
    const error = errorFrom(await finishRetries(sdkClient(fetch)));
    expectPrivate(error);
    expect(error.message).toBe(`Claude API ${category} (HTTP ${status})`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 529])(
    'retains SDK HTTP%s retry behavior without trusting body words',
    async (status) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn(() => Promise.resolve(acceptedResponse()))
        .mockImplementationOnce(() => Promise.resolve(rejectedResponse(status)));
      const result = await finishRetries(sdkClient(fetch));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content).toBe('accepted');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('retains the five-attempt SDK retry budget and returns a private final error', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.resolve(rejectedResponse(429)));
    const error = errorFrom(await finishRetries(sdkClient(fetch)));
    expectPrivate(error);
    expect(error.message).toBe('Claude API rate_limit_error (HTTP 429)');
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps compatible-provider response content out of diagnostics and retry policy', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ICO_PROVIDER', 'openai');
    const fetch = vi
      .fn(() => Promise.resolve(acceptedResponse(true)))
      .mockImplementationOnce(() =>
        Promise.resolve(rejectedResponse(401, [KEY, PROMPT, BODY, 'overloaded_error'].join(':'))),
      );
    vi.stubGlobal('fetch', fetch);
    const error = errorFrom(await finishRetries(createClaudeClient(KEY)));
    expectPrivate(error);
    expect(error.message).toBe('OpenAI API authentication_error (HTTP 401)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('retains compatible HTTP%s retries', async (status) => {
    vi.useFakeTimers();
    vi.stubEnv('ICO_PROVIDER', 'openai');
    const fetch = vi
      .fn(() => Promise.resolve(acceptedResponse(true)))
      .mockImplementationOnce(() => Promise.resolve(rejectedResponse(status)));
    vi.stubGlobal('fetch', fetch);
    const result = await finishRetries(createClaudeClient(KEY));
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains the compatible overload retry budget', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ICO_PROVIDER', 'openai');
    const fetch = vi.fn(() => Promise.resolve(rejectedResponse(503)));
    vi.stubGlobal('fetch', fetch);
    const error = errorFrom(await finishRetries(createClaudeClient(KEY)));
    expectPrivate(error);
    expect(error.message).toBe('OpenAI API overloaded_error (HTTP 503)');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each(['pending', 'reject', 'throw'])(
    'does not read error bodies or wait for %s cancellation',
    async (behavior) => {
      vi.stubEnv('ICO_PROVIDER', 'openai');
      const response = rejectedResponse(401);
      const text = vi.spyOn(response, 'text').mockRejectedValue(new Error(BODY));
      const json = vi.spyOn(response, 'json').mockRejectedValue(new Error(BODY));
      const cancel = vi.spyOn(response.body!, 'cancel').mockImplementation(() => {
        if (behavior === 'throw') throw new Error(BODY);
        if (behavior === 'reject') return Promise.reject(new Error(BODY));
        return new Promise<void>(() => {});
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(response)),
      );
      const error = errorFrom(await createClaudeClient(KEY).createCompletion('system', PROMPT));
      expectPrivate(error);
      expect(error.message).toBe('OpenAI API authentication_error (HTTP 401)');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('does not trust retry words in an arbitrary thrown Error', async () => {
    vi.useFakeTimers();
    const create = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error(`${KEY}: rate_limit_error overloaded_error`));
    const error = errorFrom(await finishRetries(createClaudeClient('', { messages: { create } })));
    expectPrivate(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not trust a plain status-bearing object', async () => {
    const create = vi.fn<() => Promise<never>>().mockRejectedValue({ status: 429, message: KEY });
    const error = errorFrom(
      await createClaudeClient('', { messages: { create } }).createCompletion('system', PROMPT),
    );
    expectPrivate(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not inspect an unknown message getter', async () => {
    const raw = new Error();
    const getter = vi.fn(() => {
      throw new Error(KEY);
    });
    Object.defineProperty(raw, 'message', { get: getter });
    const create = vi.fn<() => Promise<never>>().mockRejectedValue(raw);
    const error = errorFrom(
      await createClaudeClient('', { messages: { create } }).createCompletion('system', PROMPT),
    );
    expectPrivate(error);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [() => new APIConnectionTimeoutError({ message: KEY }), 'timed out'],
    [() => new APIUserAbortError({ message: KEY }), 'aborted'],
    [() => new APIConnectionError({ message: KEY, cause: new Error(BODY) }), 'connection failed'],
  ])('retains safe SDK transport diagnostics', async (makeError, diagnostic) => {
    const create = vi.fn<() => Promise<never>>().mockRejectedValue(makeError());
    const error = errorFrom(
      await createClaudeClient('', { messages: { create } }).createCompletion('system', PROMPT),
    );
    expectPrivate(error);
    expect(error.message).toContain(diagnostic);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps compatible network failures private without retrying message keywords', async () => {
    vi.stubEnv('ICO_PROVIDER', 'openai');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError(`${KEY}: rate_limit_error overloaded_error`));
    vi.stubGlobal('fetch', fetch);
    const error = errorFrom(await createClaudeClient(KEY).createCompletion('system', PROMPT));
    expectPrivate(error);
    expect(error.message).toBe('Provider API connection failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps malformed compatible response content out of its diagnostic', async () => {
    vi.stubEnv('ICO_PROVIDER', 'openai');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(`${PROMPT}: invalid JSON`))),
    );
    const error = errorFrom(await createClaudeClient(KEY).createCompletion('system', PROMPT));
    expectPrivate(error);
    expect(error.message).toBe('Provider API invalid response');
  });

  it('reports an owned compatible timeout without echoing the rejection', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ICO_PROVIDER', 'openai');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Expected the owned timeout signal');
          signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = createClaudeClient(KEY).createCompletion('system', PROMPT, { timeout: 25 });
    await vi.runAllTimersAsync();
    const error = errorFrom(await pending);
    expectPrivate(error);
    expect(error.message).toBe('Provider API request timed out');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
