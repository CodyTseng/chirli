import type { Next } from './bot-handlers.js';

export interface RequestTiming {
  readonly durationMs: number;
  readonly outcome: 'success' | 'failure';
}

export type RequestTimingObserver = (timing: Readonly<RequestTiming>) => void | Promise<void>;
export interface RequestTimingOptions { onTiming: RequestTimingObserver }

/** Time the downstream middleware/command chain without inspecting any context or error data. */
export function requestTiming(options: RequestTimingOptions): (_context: unknown, next: Next) => Promise<void> {
  const observer = options?.onTiming;
  if (typeof observer !== 'function') throw new TypeError('requestTiming requires an onTiming observer');
  return async (_context, next) => {
    const start = performance.now();
    let outcome: RequestTiming['outcome'] = 'failure';
    try {
      await next();
      outcome = 'success';
    } finally {
      const metric: Readonly<RequestTiming> = Object.freeze({ durationMs: Math.max(0, performance.now() - start), outcome });
      try {
        // Monitoring cannot delay/replace processing or turn success into a retryable failure.
        void Promise.resolve(observer(metric)).catch(() => {});
      } catch { /* Observer exceptions are isolated, including while unwinding a handler failure. */ }
    }
  };
}
