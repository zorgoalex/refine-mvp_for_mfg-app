import { z } from 'zod';
import { DEFAULT_API_PREFIX, isVersionedApiPrefix, normalizeApiPrefix } from './api-prefix';

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .default(false)
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

const optionalBooleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

const sameSiteFromEnv = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.toLowerCase() : value),
    z.enum(['lax', 'strict', 'none']),
  )
  .default('lax');

const emptyTrimmedStringFromEnv = z.string().trim().length(0).transform(() => undefined);

const optionalTrimmedStringFromEnv = z
  .union([z.string().trim().min(1), emptyTrimmedStringFromEnv])
  .optional();

const optionalUrlFromEnv = z
  .union([z.string().trim().url(), emptyTrimmedStringFromEnv])
  .optional();

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_NAME: z.string().trim().min(1).default('erp-backend'),
    API_PREFIX: z
      .string()
      .trim()
      .default(DEFAULT_API_PREFIX)
      .transform(normalizeApiPrefix)
      .refine(isVersionedApiPrefix, 'API_PREFIX must use /api/vN format'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    FRONTEND_ORIGIN: z.string().url().optional(),
    CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
    CORS_ALLOW_CREDENTIALS: booleanFromEnv.default(true),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: booleanFromEnv,
    REQUEST_ID_HEADER: z
      .string()
      .trim()
      .min(1)
      .default('x-request-id')
      .transform((value) => value.toLowerCase()),
    SWAGGER_ENABLED: booleanFromEnv.default(true),
    SWAGGER_PATH: z.string().trim().min(1).default('/docs'),
    DATABASE_URL: z
      .string()
      .trim()
      .min(1)
      .refine(isPostgresUrl, 'DATABASE_URL must be a postgres connection string')
      .optional(),
    DATABASE_SSL: booleanFromEnv.default(false),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(1),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    REDIS_URL: z.string().trim().min(1).optional(),
    READINESS_REQUIRE_DATABASE: booleanFromEnv.default(false),
    READINESS_REQUIRE_REDIS: booleanFromEnv.default(false),
    JWT_ACCESS_SECRET: z.string().trim().min(32).optional(),
    REFRESH_TOKEN_PEPPER: z.string().trim().min(32).optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    REFRESH_COOKIE_SECURE: optionalBooleanFromEnv,
    REFRESH_COOKIE_SAME_SITE: sameSiteFromEnv,
    BACKEND_ENABLE_AUTH: booleanFromEnv.default(false),
    BACKEND_ENABLE_ORDERS: booleanFromEnv.default(false),
    BACKEND_ENABLE_PAYMENTS: booleanFromEnv.default(false),
    BACKEND_ENABLE_PRODUCTION_ACTIONS: booleanFromEnv.default(false),
    BACKEND_ENABLE_ORDER_EXPORT: booleanFromEnv.default(false),
    BACKEND_ENABLE_USERS: booleanFromEnv.default(false),
    BACKEND_ENABLE_VLM: booleanFromEnv.default(false),
    BACKEND_ENABLE_DEADLINES: booleanFromEnv.default(false),
    BACKEND_ORDERS_READ_ONLY: booleanFromEnv.default(true),
    BACKEND_EXPORT_DISABLED: booleanFromEnv.default(true),
    BACKEND_VLM_DISABLED: booleanFromEnv.default(true),
    BACKEND_DEADLINES_READ_ONLY: booleanFromEnv.default(true),
    BACKEND_ENABLE_DEADLINE_WORKER: booleanFromEnv.default(false),
    BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    BACKEND_DEADLINE_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),
    BACKEND_DEADLINE_WORKER_ID: z.string().trim().min(1).default('backend-local'),
    BACKEND_DEADLINE_ACTIONS_ENABLED: booleanFromEnv.default(false),
    BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: booleanFromEnv.default(false),
    GAS_WEBAPP_URL: optionalUrlFromEnv,
    GAS_API_KEY: optionalTrimmedStringFromEnv,
    GAS_EXPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(55000),
    VLM_API_URL: optionalUrlFromEnv,
    VLM_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    VLM_UPLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    VLM_ANALYZE_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
    VLM_ANALYZE_DAILY_LIMIT: z.coerce.number().int().positive().default(100),
    AUTH0_M2M_DOMAIN: optionalTrimmedStringFromEnv,
    AUTH0_M2M_CLIENT_ID: optionalTrimmedStringFromEnv,
    AUTH0_M2M_CLIENT_SECRET: optionalTrimmedStringFromEnv,
    AUTH0_M2M_AUDIENCE: optionalTrimmedStringFromEnv,
    VLM_MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
    VLM_ALLOWED_MIME_TYPES: z
      .string()
      .trim()
      .min(1)
      .default('image/jpeg,image/png,image/webp'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.FRONTEND_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        message: 'FRONTEND_ORIGIN is required in production',
        path: ['FRONTEND_ORIGIN'],
      });
    }

    if (env.CORS_ALLOW_CREDENTIALS && env.CORS_ALLOWED_ORIGINS?.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        message: 'CORS_ALLOWED_ORIGINS cannot contain * when CORS_ALLOW_CREDENTIALS is true',
        path: ['CORS_ALLOWED_ORIGINS'],
      });
    }

    if (env.READINESS_REQUIRE_DATABASE && !env.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_URL is required when READINESS_REQUIRE_DATABASE is true',
        path: ['DATABASE_URL'],
      });
    }

    if (env.DATABASE_POOL_MIN > env.DATABASE_POOL_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_POOL_MIN cannot be greater than DATABASE_POOL_MAX',
        path: ['DATABASE_POOL_MIN'],
      });
    }

    if (env.BACKEND_ENABLE_AUTH) {
      if (!env.DATABASE_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'DATABASE_URL is required when BACKEND_ENABLE_AUTH is true',
          path: ['DATABASE_URL'],
        });
      }

      if (!env.JWT_ACCESS_SECRET) {
        ctx.addIssue({
          code: 'custom',
          message: 'JWT_ACCESS_SECRET is required when BACKEND_ENABLE_AUTH is true',
          path: ['JWT_ACCESS_SECRET'],
        });
      }

      if (!env.REFRESH_TOKEN_PEPPER) {
        ctx.addIssue({
          code: 'custom',
          message: 'REFRESH_TOKEN_PEPPER is required when BACKEND_ENABLE_AUTH is true',
          path: ['REFRESH_TOKEN_PEPPER'],
        });
      }

      const refreshCookieSecure = env.REFRESH_COOKIE_SECURE ?? env.NODE_ENV === 'production';

      if (env.REFRESH_COOKIE_SAME_SITE === 'none' && !refreshCookieSecure) {
        ctx.addIssue({
          code: 'custom',
          message: 'REFRESH_COOKIE_SECURE=true is required when REFRESH_COOKIE_SAME_SITE=none',
          path: ['REFRESH_COOKIE_SECURE'],
        });
      }
    }

    if (env.BACKEND_ENABLE_PAYMENTS && !env.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_URL is required when BACKEND_ENABLE_PAYMENTS is true',
        path: ['DATABASE_URL'],
      });
    }

    if (env.BACKEND_ENABLE_PRODUCTION_ACTIONS && !env.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_URL is required when BACKEND_ENABLE_PRODUCTION_ACTIONS is true',
        path: ['DATABASE_URL'],
      });
    }

    if (env.BACKEND_ENABLE_ORDER_EXPORT && env.BACKEND_EXPORT_DISABLED === false) {
      if (!env.DATABASE_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'DATABASE_URL is required when order export is enabled',
          path: ['DATABASE_URL'],
        });
      }

      if (!env.GAS_WEBAPP_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'GAS_WEBAPP_URL is required when order export is enabled',
          path: ['GAS_WEBAPP_URL'],
        });
      }

      if (!env.GAS_API_KEY) {
        ctx.addIssue({
          code: 'custom',
          message: 'GAS_API_KEY is required when order export is enabled',
          path: ['GAS_API_KEY'],
        });
      }
    }

    if (env.BACKEND_ENABLE_VLM && env.BACKEND_VLM_DISABLED === false) {
      if (!env.DATABASE_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'DATABASE_URL is required when VLM actions are enabled',
          path: ['DATABASE_URL'],
        });
      }

      if (!env.VLM_API_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'VLM_API_URL is required when VLM actions are enabled',
          path: ['VLM_API_URL'],
        });
      }

      for (const key of [
        'AUTH0_M2M_DOMAIN',
        'AUTH0_M2M_CLIENT_ID',
        'AUTH0_M2M_CLIENT_SECRET',
        'AUTH0_M2M_AUDIENCE',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required when VLM actions are enabled`,
            path: [key],
          });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    CORS_ALLOWED_ORIGINS:
      env.CORS_ALLOWED_ORIGINS ?? env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  }));

export type BackendEnv = z.infer<typeof envSchema>;

export function validateEnv(env: NodeJS.ProcessEnv): BackendEnv {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid backend environment: ${details}`);
  }

  return parsed.data;
}

export function validateEnvForNest(env: Record<string, unknown>): BackendEnv {
  return validateEnv(env as NodeJS.ProcessEnv);
}
