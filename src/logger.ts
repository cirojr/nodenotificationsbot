import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Create the process logger. Logs are JSON on stdout (systemd friendly).
 * Set LOG_LEVEL=debug for per-sample logging.
 */
export function createLogger(level?: string): Logger {
  return pino({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: {service: 'nodenotificationsbot'},
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        '*.password',
        '*.cookie',
        'req.headers.authorization',
        'rpcPassword',
      ],
      censor: '[redacted]',
    },
  });
}
