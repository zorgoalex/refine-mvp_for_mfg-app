import { z } from 'zod';

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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_NAME: z.string().trim().min(1).default('erp-backend'),
    API_PREFIX: z.string().trim().default('/api'),
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
    DATABASE_URL: z.string().trim().min(1).optional(),
    REDIS_URL: z.string().trim().min(1).optional(),
    READINESS_REQUIRE_DATABASE: booleanFromEnv.default(false),
    READINESS_REQUIRE_REDIS: booleanFromEnv.default(false),
    BACKEND_ENABLE_AUTH: booleanFromEnv.default(false),
    BACKEND_ENABLE_ORDERS: booleanFromEnv.default(false),
    BACKEND_ENABLE_ORDER_EXPORT: booleanFromEnv.default(false),
    BACKEND_ENABLE_USERS: booleanFromEnv.default(false),
    BACKEND_ENABLE_VLM: booleanFromEnv.default(false),
    BACKEND_ORDERS_READ_ONLY: booleanFromEnv.default(true),
    BACKEND_EXPORT_DISABLED: booleanFromEnv.default(true),
    BACKEND_VLM_DISABLED: booleanFromEnv.default(true),
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
