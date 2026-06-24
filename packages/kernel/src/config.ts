import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { providerRequiresKey, resolveApiKey, resolveModel, resolveProvider } from '@ico/types';

export interface IcoConfig {
  workspace: string;
  /** The active provider id (`ICO_PROVIDER`), e.g. `anthropic`, `groq`, `deepseek`. */
  provider: string;
  model: string;
  researchModel: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Non-enumerable, non-serializable. Never appears in JSON.stringify output. */
  readonly apiKey: string;
}

const SECRET_PATTERNS = [/^sk-ant-/, /^sk-/, /^Bearer\s/];

const SECRET_FIELD_NAMES = new Set([
  'apikey',
  'api_key',
  'apiKey',
  'authorization',
  'token',
  'secret',
  'password',
  'credential',
]);

/**
 * Strips known secret field names and value patterns from an object.
 * Returns a new object with sensitive values replaced by '[REDACTED]'.
 */
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string' && SECRET_PATTERNS.some((p) => p.test(value))) {
      result[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      result[key] = (value as unknown[]).map((item): unknown => {
        if (typeof item === 'string' && SECRET_PATTERNS.some((p) => p.test(item))) {
          return '[REDACTED]';
        }
        if (typeof item === 'object' && item !== null) {
          return redactSecrets(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadEnvFile(dir: string): Record<string, string> {
  const envPath = resolve(dir, '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

const VALID_LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

function isValidLogLevel(level: unknown): level is IcoConfig['logLevel'] {
  return typeof level === 'string' && VALID_LOG_LEVELS.has(level);
}

/**
 * Load ICO configuration from environment variables and .env file.
 * API key is stored as a non-enumerable property.
 */
export function loadConfig(cwd: string = process.cwd()): IcoConfig {
  const fileVars = loadEnvFile(cwd);
  const env = { ...fileVars, ...process.env };

  // Provider selection is fully model-agnostic: ICO_PROVIDER (default `anthropic`)
  // resolves to a provider record (wire format, base URL, key env, default model)
  // via the shared registry. The compiler routes on the same record, so config and
  // transport never disagree about which backend is active.
  const provider = resolveProvider(env);
  const apiKey = resolveApiKey(provider, env);
  if (apiKey === '' && providerRequiresKey(provider)) {
    const keyHint = provider.keyEnv.length > 0 ? provider.keyEnv.join(' or ') : 'ICO_API_KEY';
    throw new Error(
      `${keyHint} is required for ICO_PROVIDER=${provider.id} (${provider.label}). ` +
        'Set it in your environment or .env file.\nSee .env.example for configuration options.',
    );
  }

  // The model default is the provider's own default unless ICO_MODEL overrides it.
  // The research model follows the same rule, but keeps Anthropic's opus default
  // when the provider is Anthropic (a deliberately stronger model for research).
  const model = resolveModel(provider, env);
  const researchModel =
    env['ICO_RESEARCH_MODEL'] ?? (provider.id === 'anthropic' ? 'claude-opus-4-6' : model);

  const config = {
    workspace: env['ICO_WORKSPACE'] ?? './workspace',
    provider: provider.id,
    model,
    researchModel,
    logLevel: isValidLogLevel(env['ICO_LOG_LEVEL']) ? env['ICO_LOG_LEVEL'] : 'info',
  };

  // Make apiKey non-enumerable so JSON.stringify(config) never includes it
  Object.defineProperty(config, 'apiKey', {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return config as IcoConfig;
}
