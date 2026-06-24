/**
 * Claude API client wrapper for the ICO compiler.
 *
 * Provides a thin, Result-typed layer over @anthropic-ai/sdk with:
 * - Exponential backoff retry on 429/529
 * - Structured error classification (auth, rate-limit, overloaded, bad-request, server)
 * - API key never logged or surfaced in returned errors
 * - Prompt injection detection via sanitizeForPrompt
 * - Token estimation heuristic
 *
 * Never throws — all error paths return err(Error).
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';

import {
  err,
  ok,
  type ProviderConfig,
  resolveModel,
  resolveProvider,
  type Result,
} from '@ico/types';

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = parseInt(process.env['ICO_API_TIMEOUT'] ?? '120000', 10);
const DEFAULT_MAX_TOKENS = parseInt(process.env['MAX_TOKENS_PER_OPERATION'] ?? '4096', 10);

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;

/** Delay in milliseconds for each retry attempt (exponential: 1s, 2s, 4s, 8s, 16s). */
function retryDelayMs(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

// ---------------------------------------------------------------------------
// Injection patterns
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+the\s+above/i,
  /system\s*prompt/i,
  /you\s+are\s+now/i,
  /disregard\s+(all\s+)?prior/i,
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for a single completion request. */
export interface CompletionOptions {
  /** Model to use. Defaults to ICO_MODEL, else the selected provider's default model. */
  model?: string;
  /** Maximum tokens in the response. Defaults to MAX_TOKENS_PER_OPERATION env var, or 4096. */
  maxTokens?: number;
  /** Sampling temperature. Defaults to 0 (deterministic). */
  temperature?: number;
  /** Request timeout in milliseconds. Defaults to ICO_API_TIMEOUT env var, or 120000. */
  timeout?: number;
}

/** Structured result from a successful completion. */
export interface CompletionResult {
  /** The assistant's response text. */
  content: string;
  /** Number of input tokens billed. */
  inputTokens: number;
  /** Number of output tokens billed. */
  outputTokens: number;
  /** The model that produced the response. */
  model: string;
  /** The reason the model stopped generating. */
  stopReason: string;
}

/** Thin wrapper around the Anthropic SDK client. */
export interface ClaudeClient {
  /**
   * Send a completion request with separate system and user prompts.
   *
   * Retries on 429 (rate limit) and 529 (overloaded) with exponential backoff.
   * Returns err(Error) for all failure modes — never throws.
   *
   * @param systemPrompt - Instructions for the model.
   * @param userPrompt   - The user turn content.
   * @param options      - Optional overrides for model, tokens, temperature, timeout.
   */
  createCompletion(
    systemPrompt: string,
    userPrompt: string,
    options?: CompletionOptions,
  ): Promise<Result<CompletionResult, Error>>;
}

// ---------------------------------------------------------------------------
// Internal: error sanitization
// ---------------------------------------------------------------------------

/**
 * Build a clean Error from an Anthropic SDK error, never exposing auth headers
 * or the raw SDK error chain. Only the HTTP status and a safe message survive.
 */
function sanitizeApiError(raw: unknown): Error {
  if (raw instanceof APIError) {
    const status = (raw as { status?: number }).status ?? 0;
    let category: string;

    if (status === 401) {
      category = 'authentication_error';
    } else if (status === 400) {
      category = 'bad_request_error';
    } else if (status === 429) {
      category = 'rate_limit_error';
    } else if (status === 529) {
      category = 'overloaded_error';
    } else if (status >= 500) {
      category = 'server_error';
    } else {
      category = 'api_error';
    }

    // Strip auth headers, raw body, requestID — safe message only
    return new Error(`Claude API ${category} (HTTP ${status}): ${raw.message}`);
  }

  if (raw instanceof Error) {
    // May be a network error, timeout, etc. — return as-is (no auth leakage)
    return new Error(`Claude API request failed: ${raw.message}`);
  }

  return new Error('Claude API request failed: unknown error');
}

// ---------------------------------------------------------------------------
// Internal: sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Internal: minimal SDK surface used by this wrapper
// ---------------------------------------------------------------------------

/**
 * The subset of the Anthropic SDK that this wrapper consumes.
 * Using a structural type (not the class itself) allows plain objects to be
 * injected in tests without requiring real SDK instances.
 */
interface AnthropicLike {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature: number;
        system: string;
        messages: ReadonlyArray<{ role: string; content: string }>;
      },
      options?: { timeout?: number },
    ): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Internal: single attempt
// ---------------------------------------------------------------------------

async function attempt(
  client: AnthropicLike,
  systemPrompt: string,
  userPrompt: string,
  options: Required<CompletionOptions>,
): Promise<Result<CompletionResult, Error>> {
  try {
    const response = await client.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { timeout: options.timeout },
    );

    // Extract text content — the first text block wins
    let content = '';
    for (const block of response.content) {
      if (block.type === 'text' && block.text !== undefined) {
        content = block.text;
        break;
      }
    }

    return ok({
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
      stopReason: response.stop_reason ?? 'unknown',
    });
  } catch (raw) {
    return err(sanitizeApiError(raw));
  }
}

// ---------------------------------------------------------------------------
// Internal: OpenAI-compatible adapter
//
// Many providers (OpenAI, Groq, NVIDIA, DeepSeek-openai, and any local
// Ollama/vLLM/LM-Studio server) speak the OpenAI chat-completions API. We expose
// that wire format as an AnthropicLike duck type so createClaudeClient's retry /
// error-sanitize / token-accounting logic is reused verbatim — only the transport
// differs. Selected via ICO_PROVIDER (any openai-wire provider) with the matching
// key env. No new SDK dependency: Node's global fetch carries it.
// ---------------------------------------------------------------------------

interface OpenAiChatResponse {
  // `reasoning_content` carries the output of reasoning models (e.g.
  // deepseek-reasoner); plain chat models use `content`.
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/** Is this model id usable by an OpenAI-wire backend (i.e. not an Anthropic model)? */
function isOpenAiWireModel(model: string): boolean {
  // An Anthropic model name (claude-*) is meaningless to an OpenAI-wire backend;
  // treat the provider default as authoritative instead. We accept any model that
  // does NOT look like an Anthropic model, so callers can pass through
  // provider-native ids (gpt-*, llama-*, deepseek-*, …) freely.
  return !model.toLowerCase().startsWith('claude');
}

/**
 * Build an OpenAI-chat-completions adapter for an openai-wire {@link ProviderConfig}.
 *
 * @param provider - The resolved provider (supplies baseURL + defaultModel).
 * @param apiKey   - The provider key. May be empty for a keyless local server,
 *                   in which case no Authorization header is sent.
 */
function createOpenAiAdapter(provider: ProviderConfig, apiKey: string): AnthropicLike {
  const baseUrl = (provider.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const fallbackModel = provider.defaultModel;
  const label = provider.label;

  return {
    messages: {
      async create(params, options) {
        // Anthropic model names (e.g. claude-sonnet-4-6) are meaningless to an
        // OpenAI-wire backend; honor a provider-native model, otherwise fall back
        // to the provider's default.
        const model = isOpenAiWireModel(params.model) ? params.model : fallbackModel;

        const controller = new AbortController();
        const timer =
          options?.timeout != null
            ? setTimeout(() => controller.abort(), options.timeout)
            : undefined;

        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          // Only send Authorization when we actually have a key (local servers
          // are often keyless; an empty Bearer token can be rejected outright).
          if (apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`;

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              max_tokens: params.max_tokens,
              temperature: params.temperature,
              messages: [
                ...(params.system ? [{ role: 'system', content: params.system }] : []),
                ...params.messages,
              ],
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const status = res.status;
            const body = await res.text().catch(() => '');
            // Map onto the same category strings the retry logic keys off of.
            const category =
              status === 401
                ? 'authentication_error'
                : status === 429
                  ? 'rate_limit_error'
                  : status === 503
                    ? 'overloaded_error'
                    : status >= 500
                      ? 'server_error'
                      : 'bad_request_error';
            throw new Error(`${label} API ${category} (HTTP ${status}): ${body.slice(0, 200)}`);
          }

          const data = (await res.json()) as OpenAiChatResponse;
          const choice = data.choices?.[0];
          // Prefer `content`; fall back to `reasoning_content` when a reasoning
          // model leaves `content` empty, so an explicitly-configured reasoning
          // model still yields output instead of silently compiling 0 pages.
          const text = choice?.message?.content || choice?.message?.reasoning_content || '';
          return {
            content: [{ type: 'text', text }],
            usage: {
              input_tokens: data.usage?.prompt_tokens ?? 0,
              output_tokens: data.usage?.completion_tokens ?? 0,
            },
            model: data.model ?? model,
            stop_reason: choice?.finish_reason ?? 'stop',
          };
        } finally {
          if (timer != null) clearTimeout(timer);
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public: createClaudeClient
// ---------------------------------------------------------------------------

/**
 * Build the transport for a resolved {@link ProviderConfig}.
 *
 * - `openai`-wire providers route through the in-process OpenAI-compatible
 *   fetch adapter.
 * - `anthropic`-wire providers use the Anthropic SDK, optionally pointed at an
 *   Anthropic-*compatible* base URL (e.g. DeepSeek's `/anthropic` endpoint or a
 *   custom gateway). A `null` base URL means the SDK default (native Anthropic).
 */
function buildTransport(provider: ProviderConfig, apiKey: string): AnthropicLike {
  if (provider.wire === 'openai') {
    return createOpenAiAdapter(provider, apiKey);
  }
  const anthropicOptions: { apiKey: string; maxRetries: number; baseURL?: string } = {
    apiKey,
    maxRetries: 0,
  };
  if (provider.baseURL !== null) {
    anthropicOptions.baseURL = provider.baseURL;
  }
  return new Anthropic(anthropicOptions) as unknown as AnthropicLike;
}

/**
 * Create a {@link ClaudeClient}.
 *
 * Provider is selected by `ICO_PROVIDER` (default `anthropic`) via the provider
 * registry: `openai`-wire providers (OpenAI, Groq, NVIDIA, DeepSeek, local
 * Ollama/vLLM) route through the in-process OpenAI-compatible adapter;
 * `anthropic`-wire providers (Anthropic native, DeepSeek-anthropic, custom)
 * use the Anthropic SDK with an optional base-URL override. Either way the same
 * retry / error-sanitize / Result-typed surface is returned.
 *
 * @param apiKey            - Provider API key for the selected provider. Never logged.
 * @param anthropicInstance - Optional SDK-shaped object; provide in tests to avoid real HTTP
 *                            calls. Must satisfy the {@link AnthropicLike} duck type. Takes
 *                            precedence over the provider switch.
 */
export function createClaudeClient(apiKey: string, anthropicInstance?: unknown): ClaudeClient {
  const provider = resolveProvider(process.env);
  const sdkClient: AnthropicLike =
    anthropicInstance != null
      ? (anthropicInstance as AnthropicLike)
      : buildTransport(provider, apiKey);

  // Default model is provider-aware: `ICO_MODEL` wins, otherwise the selected
  // provider's default (so a non-Anthropic provider never falls back to a Claude
  // model name it can't serve).
  const defaultModel = resolveModel(provider, process.env);

  return {
    async createCompletion(
      systemPrompt: string,
      userPrompt: string,
      options?: CompletionOptions,
    ): Promise<Result<CompletionResult, Error>> {
      const resolved: Required<CompletionOptions> = {
        model: options?.model ?? defaultModel,
        maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options?.temperature ?? 0,
        timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
      };

      let lastError: Error = new Error('No attempts made');

      for (let i = 0; i < MAX_RETRIES; i++) {
        if (i > 0) {
          await sleep(retryDelayMs(i - 1));
        }

        const result = await attempt(sdkClient, systemPrompt, userPrompt, resolved);

        if (result.ok) {
          return result;
        }

        lastError = result.error;

        // Determine if this error is retryable by inspecting the message
        // (we already sanitized the status into the message string)
        const isRetryable =
          lastError.message.includes('rate_limit_error') ||
          lastError.message.includes('overloaded_error');

        if (!isRetryable) {
          return err(lastError);
        }
      }

      return err(lastError);
    },
  };
}

// ---------------------------------------------------------------------------
// Public: createClaudeClientFromSdk (testability overload using Anthropic type)
// ---------------------------------------------------------------------------

/**
 * Create a {@link ClaudeClient} from a pre-constructed Anthropic SDK instance (or any
 * object satisfying the duck-typed {@link AnthropicLike} surface).
 * Useful for injecting mocks in tests without the `unknown` cast.
 *
 * @internal
 */
export function createClaudeClientFromSdk(sdkInstance: AnthropicLike): ClaudeClient {
  return createClaudeClient('', sdkInstance);
}

// ---------------------------------------------------------------------------
// Public: estimateTokens
// ---------------------------------------------------------------------------

/**
 * Rough token estimate using the chars/4 heuristic.
 *
 * Not a substitute for the API's actual billing — use only for pre-flight
 * checks and prompt-length guards.
 *
 * @param text - The string to estimate.
 * @returns Estimated token count (ceiling).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Public: sanitizeForPrompt
// ---------------------------------------------------------------------------

/** Result of a prompt-injection safety scan. */
export interface SanitizeResult {
  /** The content unchanged — sanitization never mutates. */
  sanitized: string;
  /** Human-readable descriptions of any detected patterns. */
  warnings: string[];
}

/**
 * Scan content for known prompt-injection patterns.
 *
 * Does NOT block or modify the content. Returns the original string plus any
 * warnings so callers can decide how to handle them.
 *
 * @param content - Raw user-provided content to scan.
 */
export function sanitizeForPrompt(content: string): SanitizeResult {
  const warnings: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(content);
    if (match !== null) {
      warnings.push(
        `Potential prompt injection detected matching pattern /${pattern.source}/i: "${match[0]}"`,
      );
    }
  }

  return { sanitized: content, warnings };
}
