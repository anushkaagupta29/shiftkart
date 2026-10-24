import { loadRootEnv, requireEnv } from '@shiftkart/db';

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  dataKey: string;
  hashKey: string;
  corsOrigins: string[];
  devEndpoints: boolean;
  rateLimitPerMin: number;
  otpGlobalHourly: number;
  mockpayWebhookSecret: string;
  publicApiUrl: string;
  trustProxy: number | false;
  /** DPDP grievance officer shown in the apps (LEGAL L-22). Empty until a real person is appointed. */
  grievance: { name: string; email: string };
  logLevel: string;
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadRootEnv();
  const env = (process.env.NODE_ENV ?? 'development') as Config['env'];
  const cfg: Config = {
    env,
    port: Number(process.env.API_PORT ?? 4000),
    databaseUrl: requireEnv('DATABASE_URL'),
    dataKey: requireEnv('DATA_KEY'),
    hashKey: requireEnv('HASH_KEY'),
    corsOrigins: [process.env.ADMIN_ORIGIN, process.env.BUSINESS_ORIGIN, process.env.WORKER_WEB_ORIGIN].filter(Boolean) as string[],
    devEndpoints: process.env.DEV_ENDPOINTS === 'true',
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
    otpGlobalHourly: Number(process.env.OTP_GLOBAL_HOURLY ?? 1000),
    mockpayWebhookSecret: requireEnv('MOCKPAY_WEBHOOK_SECRET'),
    publicApiUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:4000',
    // Behind a load balancer set TRUST_PROXY=1 so per-IP rate limits see the real client address.
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
    grievance: { name: process.env.GRIEVANCE_OFFICER_NAME ?? '', email: process.env.GRIEVANCE_OFFICER_EMAIL ?? '' },
    logLevel: process.env.LOG_LEVEL ?? 'info',
    ...overrides,
  };
  // Dev-only endpoints can never be switched on in production.
  if (cfg.env === 'production') cfg.devEndpoints = false;
  // A real production process (not a test building a production-mode app) must be configured safely.
  if (process.env.NODE_ENV === 'production') {
    const problems = productionProblems(cfg);
    if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
  }
  return cfg;
}

/** Settings that must be right before real users touch the system. */
export function productionProblems(cfg: Config): string[] {
  const p: string[] = [];
  if (!cfg.publicApiUrl.startsWith('https://')) p.push('PUBLIC_API_URL must be https');
  if (cfg.corsOrigins.some((o) => !o.startsWith('https://'))) p.push('ADMIN_ORIGIN / BUSINESS_ORIGIN / WORKER_WEB_ORIGIN must be https');
  if (/localhost|127\.0\.0\.1/.test(cfg.databaseUrl)) p.push('DATABASE_URL points at a local database');
  if (cfg.trustProxy === false) p.push('TRUST_PROXY is not set (rate limits would see the load balancer, not the client)');
  if (!cfg.grievance.name || !cfg.grievance.email) p.push('GRIEVANCE_OFFICER_NAME / GRIEVANCE_OFFICER_EMAIL are not set (DPDP, LEGAL L-22)');
  if (cfg.rateLimitPerMin > 1000) p.push('RATE_LIMIT_PER_MIN is set very high');
  return p;
}
