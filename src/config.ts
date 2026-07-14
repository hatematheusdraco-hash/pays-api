import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  paysTakeRate: num('PAYS_TAKE_RATE', 0.02),
  processorIntervalMs: num('PROCESSOR_INTERVAL_MS', 1000),
  webhookDispatchIntervalMs: num('WEBHOOK_DISPATCH_INTERVAL_MS', 1000),
  quoteTtlSeconds: num('QUOTE_TTL_SECONDS', 30),
} as const;

export const isProd = config.env === 'production';
