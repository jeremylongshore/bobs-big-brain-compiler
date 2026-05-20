import { redactSecrets } from './config.js';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redactString(str: string): string {
  let result = str;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export class Logger {
  private level: number;

  constructor(level: LogLevel = 'info') {
    this.level = LOG_LEVELS[level];
  }

  setLevel(level: LogLevel): void {
    this.level = LOG_LEVELS[level];
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.debug) {
      this.write('debug', message, args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.info) {
      this.write('info', message, args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.warn) {
      this.write('warn', message, args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.level <= LOG_LEVELS.error) {
      this.write('error', message, args);
    }
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const redactedMessage = redactString(message);
    const redactedArgs = args.map((a) => {
      if (typeof a === 'string') return redactString(a);
      if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
        return redactSecrets(a as Record<string, unknown>);
      }
      return a;
    });

    const prefix = `${timestamp} [${level.toUpperCase()}]`;
    if (redactedArgs.length > 0) {
      console[level === 'debug' ? 'log' : level](`${prefix} ${redactedMessage}`, ...redactedArgs);
    } else {
      console[level === 'debug' ? 'log' : level](`${prefix} ${redactedMessage}`);
    }
  }
}

export function createLogger(level: LogLevel = 'info'): Logger {
  return new Logger(level);
}
