/**
 * Provider registry for the ICO compiler — the model-agnostic backend.
 *
 * The compiler's LLM is a swappable backend (the compiler-side analog of the
 * swappable retrieval backend). A provider is fully described by a small,
 * declarative record: its wire format, its base URL, the env var that holds its
 * key, and a default model. `createClaudeClient` consumes this record and routes
 * to the matching adapter; `loadConfig` consumes it to resolve the right key env
 * and model default. Adding a provider means adding one entry here — no branches
 * scattered across the codebase.
 *
 * Selection is driven by `ICO_PROVIDER` (default `anthropic`). Any field of a
 * built-in provider can be overridden via env (`ICO_BASE_URL`, `ICO_MODEL`,
 * `ICO_API_KEY`, `ICO_PROVIDER_WIRE`), and a fully `custom` provider can be
 * defined entirely from env so a user can house any OpenAI- or Anthropic-wire
 * endpoint (a local Ollama/vLLM server, a private gateway, a new vendor) without
 * a code change.
 *
 * Keeping Anthropic the default and making the rest first-class — not base-URL
 * hacks — is the point: the brain's compiler is model-neutral, the same way the
 * eval platform is vendor-neutral.
 */

/**
 * How a provider speaks on the wire.
 *
 * - `anthropic` — the native Anthropic Messages API (`x-api-key`, `system` +
 *   `messages`, `content` blocks). Served by the Anthropic SDK, optionally
 *   pointed at an Anthropic-*compatible* base URL (e.g. DeepSeek's
 *   `/anthropic` endpoint).
 * - `openai` — the OpenAI chat-completions API (`Authorization: Bearer`,
 *   flat `messages`, `choices[].message.content`). Served by the in-process
 *   fetch adapter; covers OpenAI, Groq, NVIDIA, DeepSeek-openai, and any local
 *   OpenAI-compatible server (Ollama, vLLM, LM Studio, …).
 */
export type WireFormat = 'anthropic' | 'openai';

/**
 * The environment shape the registry reads from — structurally compatible with
 * `process.env`. Declared locally so this package stays free of Node typings;
 * callers pass `process.env` explicitly.
 */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/** A fully-resolved provider the client can route on. */
export interface ProviderConfig {
  /** The provider id (the `ICO_PROVIDER` value), e.g. `groq`, `anthropic`. */
  readonly id: string;
  /** Which wire format / adapter to use. */
  readonly wire: WireFormat;
  /**
   * Base URL for the API. `null` means "use the SDK / library default"
   * (only meaningful for the native Anthropic provider).
   */
  readonly baseURL: string | null;
  /** The model id used when neither the call nor `ICO_MODEL` specify one. */
  readonly defaultModel: string;
  /**
   * The env var(s) that hold this provider's API key, in priority order.
   * `ICO_API_KEY` is always accepted as a generic fallback (appended by the
   * resolver), so a user can set one variable regardless of provider.
   */
  readonly keyEnv: readonly string[];
  /** Human-readable label for error messages. */
  readonly label: string;
}

/**
 * Built-in provider definitions. A `custom` provider is synthesized from env
 * (see {@link resolveProvider}) and is intentionally absent here.
 */
const BUILTIN_PROVIDERS: Readonly<Record<string, ProviderConfig>> = {
  anthropic: {
    id: 'anthropic',
    wire: 'anthropic',
    baseURL: null,
    defaultModel: 'claude-sonnet-4-6',
    keyEnv: ['ANTHROPIC_API_KEY'],
    label: 'Anthropic',
  },
  openai: {
    id: 'openai',
    wire: 'openai',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyEnv: ['OPENAI_API_KEY'],
    label: 'OpenAI',
  },
  groq: {
    id: 'groq',
    wire: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyEnv: ['GROQ_API_KEY'],
    label: 'Groq',
  },
  nvidia: {
    id: 'nvidia',
    wire: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    keyEnv: ['NVIDIA_API_KEY'],
    label: 'NVIDIA',
  },
  // DeepSeek over its OpenAI-compatible endpoint (the default DeepSeek path).
  deepseek: {
    id: 'deepseek',
    wire: 'openai',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyEnv: ['DEEPSEEK_API_KEY'],
    label: 'DeepSeek',
  },
  // DeepSeek over its Anthropic-compatible endpoint (the original base-URL hack,
  // now first-class). Uses the Anthropic SDK pointed at /anthropic.
  'deepseek-anthropic': {
    id: 'deepseek-anthropic',
    wire: 'anthropic',
    baseURL: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    keyEnv: ['DEEPSEEK_API_KEY'],
    label: 'DeepSeek (Anthropic-compatible)',
  },
  // MiniMax over its OpenAI-compatible endpoint (global; mainland-China
  // accounts use api.minimaxi.com — override via ICO_BASE_URL). MiniMax-M3 is
  // the nightly-distiller model (bead l13.9); it also exposes an
  // Anthropic-compatible endpoint at /anthropic (x-api-key auth), reachable
  // here via ICO_BASE_URL + ICO_PROVIDER_WIRE=anthropic. Both wires verified
  // live 2026-07-20 (HTTP 200, model=MiniMax-M3).
  minimax: {
    id: 'minimax',
    wire: 'openai',
    baseURL: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    keyEnv: ['MINIMAX_API_KEY'],
    label: 'MiniMax',
  },
  // A local OpenAI-compatible server (Ollama, vLLM, LM Studio, …). No key
  // required by default; override the model/base-url/key via env as needed.
  local: {
    id: 'local',
    wire: 'openai',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    keyEnv: [],
    label: 'Local (OpenAI-compatible)',
  },
};

/** Aliases that map onto a canonical built-in id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  ollama: 'local',
  vllm: 'local',
  'openai-compatible': 'local',
};

/** Normalize a raw `ICO_PROVIDER` value (trim + lowercase, alias-resolved). */
function normalizeProviderId(raw: string | undefined): string {
  const id = (raw ?? 'anthropic').trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

function parseWire(raw: string | undefined): WireFormat | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'anthropic' || v === 'openai') return v;
  return undefined;
}

/**
 * Strip trailing slashes so `${baseURL}/path` joins cleanly.
 *
 * Implemented with a linear scan rather than a `/\/+$/` regex: that pattern is a
 * polynomial-ReDoS shape (a quantifier anchored at `$`) on attacker-influenced
 * config input, so we walk back from the end instead.
 */
function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return end === url.length ? url : url.slice(0, end);
}

/**
 * Resolve the active {@link ProviderConfig} from environment.
 *
 * Resolution order:
 *  1. `ICO_PROVIDER` selects a built-in provider (or `custom`).
 *  2. A `custom` provider is built entirely from env (`ICO_PROVIDER_WIRE` +
 *     `ICO_BASE_URL` required; `ICO_MODEL` + `ICO_API_KEY` optional).
 *  3. For built-ins, `ICO_BASE_URL` overrides the base URL and
 *     `ICO_PROVIDER_WIRE` overrides the wire format (so an unknown vendor that
 *     reuses a built-in slot can flip the adapter). Provider-specific legacy
 *     vars (`DEEPSEEK_BASE_URL`) are still honored for back-compat.
 *
 * Throws on an unknown provider id (clear failure beats a silent
 * wrong-backend), and on a `custom` provider missing its required fields.
 *
 * @param env - The environment to read (pass `process.env`).
 */
export function resolveProvider(env: ProviderEnv): ProviderConfig {
  const id = normalizeProviderId(env['ICO_PROVIDER']);

  let base: ProviderConfig;

  if (id === 'custom') {
    const wire = parseWire(env['ICO_PROVIDER_WIRE']);
    if (wire === undefined) {
      throw new Error(
        "ICO_PROVIDER=custom requires ICO_PROVIDER_WIRE to be 'anthropic' or 'openai'.",
      );
    }
    const rawBase = env['ICO_BASE_URL']?.trim();
    if (rawBase === undefined || rawBase === '') {
      throw new Error('ICO_PROVIDER=custom requires ICO_BASE_URL to be set.');
    }
    base = {
      id: 'custom',
      wire,
      baseURL: trimTrailingSlash(rawBase),
      defaultModel: env['ICO_MODEL']?.trim() || 'custom-model',
      keyEnv: [],
      label: 'Custom provider',
    };
  } else {
    const builtin = BUILTIN_PROVIDERS[id];
    if (builtin === undefined) {
      const known = [...Object.keys(BUILTIN_PROVIDERS), 'custom', ...Object.keys(PROVIDER_ALIASES)]
        .sort()
        .join(', ');
      throw new Error(`Unknown ICO_PROVIDER '${id}'. Supported: ${known}.`);
    }
    base = builtin;
  }

  // Apply built-in overrides from env (custom already consumed its env above).
  const wireOverride = id === 'custom' ? undefined : parseWire(env['ICO_PROVIDER_WIRE']);
  // Provider-specific legacy base-url var (back-compat for the original DeepSeek path).
  const legacyBaseUrl = id === 'deepseek' ? env['DEEPSEEK_BASE_URL']?.trim() : undefined;
  const baseUrlOverride = env['ICO_BASE_URL']?.trim() || legacyBaseUrl;

  const resolved: ProviderConfig = {
    ...base,
    wire: wireOverride ?? base.wire,
    baseURL: baseUrlOverride ? trimTrailingSlash(baseUrlOverride) : base.baseURL,
  };

  return resolved;
}

/**
 * Resolve the API key for a provider, in priority order:
 * `ICO_API_KEY` (generic, wins) → the provider's named key env(s).
 *
 * Returns `''` when no key is found. Providers with no `keyEnv` (e.g. a local
 * server) legitimately run keyless, so an empty string is not always an error —
 * the caller decides (see {@link providerRequiresKey}).
 *
 * @param provider - The resolved provider.
 * @param env      - The environment to read (pass `process.env`).
 */
export function resolveApiKey(provider: ProviderConfig, env: ProviderEnv): string {
  const generic = env['ICO_API_KEY']?.trim();
  if (generic) return generic;
  for (const name of provider.keyEnv) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return '';
}

/**
 * Whether the provider requires an API key. A local/keyless OpenAI-compatible
 * server (`keyEnv: []` and a localhost base URL) may run without one; everything
 * else does require a key.
 */
export function providerRequiresKey(provider: ProviderConfig): boolean {
  if (provider.keyEnv.length > 0) return true;
  // `custom` / `local` with no declared key env: only require a key for a
  // non-localhost endpoint (a remote custom gateway almost certainly needs one).
  const url = provider.baseURL ?? '';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
  return !isLocal;
}

/**
 * Resolve the model id for a provider: an explicit `ICO_MODEL` wins, otherwise
 * the provider's default. (Provider-specific legacy `DEEPSEEK_MODEL` is honored
 * for back-compat with the original DeepSeek path.)
 *
 * @param provider - The resolved provider.
 * @param env      - The environment to read (pass `process.env`).
 */
export function resolveModel(provider: ProviderConfig, env: ProviderEnv): string {
  const explicit = env['ICO_MODEL']?.trim();
  if (explicit) return explicit;
  if (provider.id === 'deepseek' || provider.id === 'deepseek-anthropic') {
    const legacy = env['DEEPSEEK_MODEL']?.trim();
    if (legacy) return legacy;
  }
  return provider.defaultModel;
}

/** The list of built-in provider ids (excludes `custom` + aliases). */
export function listBuiltinProviders(): readonly string[] {
  return Object.freeze([...Object.keys(BUILTIN_PROVIDERS)]);
}
