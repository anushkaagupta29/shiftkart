import { redactPII } from '@shiftkart/shared';
import type { FastifyServerOptions } from 'fastify';

// Never log secrets or personal data (MSG-06). Request bodies are not logged at all;
// these paths cover anything that might be logged explicitly.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.phone', '*.code', '*.password', '*.totp', '*.otp',
  '*.accessToken', '*.refreshToken', '*.token',
];

export function loggerOptions(level: string, stream?: NodeJS.WritableStream): FastifyServerOptions['logger'] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    hooks: {
      // Free-text messages are scrubbed for phone numbers and emails as a second line of defence.
      logMethod(args, method) {
        const scrubbed: unknown[] = args.map((a) => (typeof a === 'string' ? redactPII(a) : a));
        // log.error(err) with no message makes pino copy err.message into `msg` unscrubbed.
        const first = scrubbed[0] as { err?: unknown } | undefined;
        const err = first instanceof Error ? first : first?.err instanceof Error ? first.err : null;
        if (err && typeof scrubbed[1] !== 'string') scrubbed.splice(1, 0, redactPII(err.message));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    serializers: {
      req: (req) => ({ method: req.method, url: redactPII(req.url.split('?')[0] ?? ''), id: req.id }),
      err: (err: Error) => ({ type: err.name, message: redactPII(err.message), stack: err.stack ? redactPII(err.stack) : undefined }),
    },
    ...(stream ? { stream } : {}),
  } as FastifyServerOptions['logger'];
}
