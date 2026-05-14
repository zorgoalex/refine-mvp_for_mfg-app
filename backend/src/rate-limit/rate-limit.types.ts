export interface RateLimitRule {
  feature: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitSubject {
  route: string;
  userId?: string | number | null;
  ipAddress?: string | null;
  username?: string | null;
  resourceId?: string | number | null;
}

export interface RateLimitConsumeInput {
  rule: RateLimitRule;
  subject: RateLimitSubject;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  key: string;
}

export interface RateLimitStore {
  consume(input: RateLimitConsumeInput): Promise<RateLimitResult>;
  ping?(): Promise<void>;
  close?(): Promise<void>;
}
