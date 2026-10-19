import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import type { Config } from './config';
import type { Db } from './db';
import { MockSms, type SmsSender } from './adapters/sms';
import { HttpError } from './lib/errors';
import { loggerOptions } from './lib/logger';
import { registerAuthGuard } from './auth/guard';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { businessRoutes } from './routes/businesses';
import { adminRoutes } from './routes/admin';
import { devRoutes } from './routes/dev';
import { businessOnboardingRoutes } from './routes/business-onboarding';
import { shiftRoutes } from './routes/shifts';
import { paymentRoutes } from './routes/payments';
import { workerRoutes } from './routes/worker';
import { workerShiftRoutes } from './routes/worker-shifts';
import { adminOpsRoutes } from './routes/admin-ops';
import { MockKyc, type KycProvider } from './adapters/kyc';
import { MockLiveness, type LivenessProvider } from './adapters/mock-face';
import { MockBank, type BankVerifier } from './adapters/bank';
import { MockGstn, type GstnProvider } from './adapters/gstn';
import { MockIntegrity, MockPayouts, type IntegrityVerifier, type PayoutProvider } from './adapters/payouts';
import { workerAttendanceRoutes } from './routes/worker-attendance';
import { businessAttendanceRoutes } from './routes/business-attendance';
import { adminFinanceRoutes } from './routes/admin-finance';
import { trustRoutes } from './routes/trust-routes';
import { analyticsRoutes } from './routes/analytics';
import './auth/types';

export type AppDeps = {
  db: Db; config: Config;
  sms: SmsSender; kyc: KycProvider; liveness: LivenessProvider; bank: BankVerifier; gstn: GstnProvider;
  payouts: PayoutProvider; integrity: IntegrityVerifier;
};

export async function buildApp(config: Config, db: Db, opts: { sms?: SmsSender; logStream?: NodeJS.WritableStream } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, opts.logStream),
    bodyLimit: 100 * 1024,
    trustProxy: false,
  });
  // Every external service is a mock until a sandbox is approved (DECISIONS D-006).
  const deps: AppDeps = {
    db, config,
    sms: opts.sms ?? new MockSms(db, config.hashKey),
    kyc: new MockKyc(db), liveness: new MockLiveness(), bank: new MockBank(), gstn: new MockGstn(db),
    payouts: new MockPayouts(db), integrity: new MockIntegrity(),
  };

  await app.register(helmet);
  // Worker phones are often on 2G/3G: compress anything over 1 KB (brotli or gzip).
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: config.rateLimitPerMin, timeWindow: '1 minute' });
  registerAuthGuard(app, db);

  app.setErrorHandler((err: Error & { statusCode?: number; issues?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      reply.headers(err.headers).code(err.statusCode);
      return { error: { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) } };
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Framework errors: bad JSON, wrong content type, body too large, rate limit.
      reply.code(status);
      return { error: { code: status === 429 ? 'rate_limited' : 'bad_request', message: status === 429 ? 'Too many requests. Slow down.' : 'Bad request.' } };
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500);
    return { error: { code: 'internal', message: 'Something went wrong. Please try again.' } };
  });

  app.get('/health', { config: { auth: { public: true } } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(async (s) => authRoutes(s, deps));
  await app.register(async (s) => meRoutes(s, deps));
  await app.register(async (s) => businessRoutes(s, deps));
  await app.register(async (s) => adminRoutes(s, deps));
  await app.register(async (s) => businessOnboardingRoutes(s, deps));
  await app.register(async (s) => shiftRoutes(s, deps));
  await app.register(async (s) => paymentRoutes(s, deps));
  await app.register(async (s) => workerRoutes(s, deps));
  await app.register(async (s) => workerShiftRoutes(s, deps));
  await app.register(async (s) => adminOpsRoutes(s, deps));
  await app.register(async (s) => workerAttendanceRoutes(s, deps));
  await app.register(async (s) => businessAttendanceRoutes(s, deps));
  await app.register(async (s) => adminFinanceRoutes(s, deps));
  await app.register(async (s) => trustRoutes(s, deps));
  await app.register(async (s) => analyticsRoutes(s, deps));
  if (config.devEndpoints && config.env !== 'production') await app.register(async (s) => devRoutes(s, deps));

  return app;
}
