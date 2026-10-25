import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '@ico/kernel';

import { createClaudeClient } from './claude-client.js';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/sdk')>()),
  default: class {
    messages = { create: sdk.create };
    constructor(options: unknown) {
      sdk.construct(options);
    }
  },
}));

describe('resolved configuration reaches the compiler transport', () => {
  let directory: string;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ico-resolved-config-'));
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ICO_') || key.endsWith('_API_KEY') || key === 'DEEPSEEK_MODEL') {
        vi.stubEnv(key, undefined);
      }
    }
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockReset()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ choices: [{ message: { content: 'fixture answer' } }] })),
      );
    sdk.construct.mockClear();
    sdk.create.mockReset().mockImplementation((params: { model: string }) =>
      Promise.resolve({
        content: [{ type: 'text', text: 'fixture answer' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: params.model,
        stop_reason: 'end_turn',
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function fileConfig(contents: string) {
    writeFileSync(join(directory, '.env'), contents);
    return loadConfig(directory);
  }

  it('uses the .env-only OpenAI wire, URL, key and model without exporting them', async () => {
    const config = fileConfig(
      'ICO_PROVIDER=groq\nICO_BASE_URL=https://gateway.invalid/v1/\n' +
        'ICO_MODEL=fixture-model\nGROQ_API_KEY=fixture-key\n',
    );
    const result = await createClaudeClient(config).createCompletion('system', 'question');
    expect(result.ok).toBe(true);
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gateway.invalid/v1/chat/completions');
    expect(request?.headers).toMatchObject({ authorization: 'Bearer fixture-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'fixture-model' });
    expect(process.env['ICO_PROVIDER']).toBeUndefined();
    expect(process.env['ICO_MODEL']).toBeUndefined();
    expect(process.env['ICO_BASE_URL']).toBeUndefined();
    expect(process.env['GROQ_API_KEY']).toBeUndefined();
    expect(config.provider).toBe(config.providerConfig.id);
    expect(JSON.stringify(config)).not.toContain('providerConfig');
    expect(JSON.stringify(config)).not.toContain('fixture-key');
    expect(JSON.stringify(config.providerConfig)).not.toContain('fixture-key');
  });

  it('uses a .env-only Anthropic-compatible URL and model', async () => {
    const config = fileConfig(
      'ICO_PROVIDER=deepseek-anthropic\nICO_BASE_URL=https://compatible.invalid/anthropic\n' +
        'ICO_MODEL=fixture-compatible\nDEEPSEEK_API_KEY=fixture-compatible-key\n',
    );
    expect((await createClaudeClient(config).createCompletion('system', 'question')).ok).toBe(true);
    expect(sdk.construct).toHaveBeenCalledWith({
      apiKey: 'fixture-compatible-key',
      baseURL: 'https://compatible.invalid/anthropic',
      maxRetries: 0,
    });
    expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({ model: 'fixture-compatible' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors environment precedence when resolving the configuration once', async () => {
    vi.stubEnv('ICO_PROVIDER', 'openai');
    vi.stubEnv('ICO_BASE_URL', 'https://environment.invalid/v1');
    vi.stubEnv('ICO_MODEL', 'environment-model');
    vi.stubEnv('ICO_API_KEY', 'environment-key');
    const config = fileConfig('ICO_PROVIDER=local\nICO_MODEL=file-model\n');
    await createClaudeClient(config).createCompletion('system', 'question');
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://environment.invalid/v1/chat/completions');
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'environment-model' });
    expect(request?.headers).toMatchObject({ authorization: 'Bearer environment-key' });
  });

  it('keeps independently loaded workspaces isolated from later environment changes', async () => {
    const first = fileConfig(
      'ICO_PROVIDER=local\nICO_BASE_URL=http://127.0.0.1:4311/v1\nICO_MODEL=first-model\n',
    );
    const second = fileConfig(
      'ICO_PROVIDER=local\nICO_BASE_URL=http://127.0.0.1:4312/v1\nICO_MODEL=second-model\n',
    );
    vi.stubEnv('ICO_PROVIDER', 'anthropic');
    vi.stubEnv('ICO_MODEL', 'ambient-model');
    await createClaudeClient(first).createCompletion('system', 'first');
    await createClaudeClient(second).createCompletion('system', 'second');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4311/v1/chat/completions',
      'http://127.0.0.1:4312/v1/chat/completions',
    ]);
    expect(
      fetchMock.mock.calls.map(
        ([, request]) => (JSON.parse(request?.body as string) as { model: string }).model,
      ),
    ).toEqual(['first-model', 'second-model']);
    expect(
      fetchMock.mock.calls.every(
        ([, request]) => !Object.hasOwn(request?.headers ?? {}, 'authorization'),
      ),
    ).toBe(true);
  });
});
