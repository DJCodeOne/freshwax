// src/lib/client-logger.ts
// Lightweight client-side logger that suppresses info/warn in production.
// Errors always log. Info and warn only log on localhost.

const isDev = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

export interface ClientLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createClientLogger(prefix: string): ClientLogger {
  const tag = `[${prefix}]`;
  return {
    info(...args: unknown[]) {
      if (isDev) console.log(tag, ...args);
    },
    warn(...args: unknown[]) {
      if (isDev) console.warn(tag, ...args);
    },
    error(...args: unknown[]) {
      console.error(tag, ...args);
    },
  };
}
