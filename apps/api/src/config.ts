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
    corsOrigins: [process.env.ADMIN_ORIGIN, process.env.BUSINESS_ORIGIN].filter(Boolean) as string[],
    devEndpoints: process.env.DEV_ENDPOINTS === 'true',
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
    otpGlobalHourly: Number(process.env.OTP_GLOBAL_HOURLY ?? 1000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    ...overrides,
  };
  // Dev-only endpoints can never be switched on in production.
  if (cfg.env === 'production') cfg.devEndpoints = false;
  return cfg;
}
