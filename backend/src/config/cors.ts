export interface CorsRuntimeOptions {
  origins: string[];
  credentials: boolean;
}

export interface CorsEnv {
  CORS_ALLOWED_ORIGINS: string;
  CORS_ALLOW_CREDENTIALS: boolean;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createCorsRuntimeOptions(env: CorsEnv): CorsRuntimeOptions {
  return {
    origins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS),
    credentials: env.CORS_ALLOW_CREDENTIALS,
  };
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
}
