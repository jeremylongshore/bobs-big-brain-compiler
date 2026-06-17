import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IcoConfig {
  workspace: string;
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

  // Provider selection (default anthropic). DeepSeek runs on its own key and
  // OpenAI-compatible models; see createClaudeClient's ICO_PROVIDER branch.
  const isDeepSeek = (env['ICO_PROVIDER'] ?? 'anthropic') === 'deepseek';
  const deepSeekModel = env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash';

  const apiKey = (isDeepSeek ? env['DEEPSEEK_API_KEY'] : env['ANTHROPIC_API_KEY']) ?? '';
  if (apiKey === '') {
    throw new Error(
      isDeepSeek
        ? 'DEEPSEEK_API_KEY is required (ICO_PROVIDER=deepseek). Set it in your environment or .env file.'
        : 'ANTHROPIC_API_KEY is required. Set it in your environment or .env file.\n' +
            'See .env.example for configuration options.',
    );
  }

  const config = {
    workspace: env['ICO_WORKSPACE'] ?? './workspace',
    model: env['ICO_MODEL'] ?? (isDeepSeek ? deepSeekModel : 'claude-sonnet-4-6'),
    researchModel: env['ICO_RESEARCH_MODEL'] ?? (isDeepSeek ? deepSeekModel : 'claude-opus-4-6'),
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
