import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueryResultRow } from 'pg';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';

interface RolloutRow extends QueryResultRow {
  value_json: unknown;
}

interface RealtimeRollout {
  enabled: boolean;
  userIds: string[];
  rolloutPercent: number;
}

interface RealtimeWritesSetting {
  enabled: boolean;
  maxFanoutOrders: number;
  maxDetailIds: number;
}

const DISABLED_ROLLOUT: RealtimeRollout = { enabled: false, userIds: [], rolloutPercent: 0 };
const ROLLOUT_SETTING_KEY = 'order_realtime.rollout';
const WRITES_SETTING_KEY = 'order_realtime.writes';
const CACHE_TTL_MS = 5000;

@Injectable()
export class OrderRealtimeRuntimeConfigService {
  private readonly logger = new Logger(OrderRealtimeRuntimeConfigService.name);
  private rolloutCache: { value: RealtimeRollout; expiresAt: number } | null = null;
  private writesCache: { value: RealtimeWritesSetting; expiresAt: number } | null = null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    private readonly database: DatabaseService,
  ) {}

  get snapshotEnabled(): boolean {
    return this.config.get('BACKEND_ENABLE_ORDER_LIVE_SNAPSHOT', { infer: true });
  }

  get writesEnabled(): boolean {
    return this.config.get('BACKEND_ENABLE_ORDER_REALTIME_WRITES', { infer: true });
  }

  get streamTransportEnabled(): boolean {
    return this.config.get('BACKEND_ENABLE_ORDER_REALTIME_STREAM', { infer: true });
  }

  get heartbeatMs(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_HEARTBEAT_MS', { infer: true });
  }

  get catchupMs(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_CATCHUP_MS', { infer: true });
  }

  get maxConnections(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_MAX_CONNECTIONS', { infer: true });
  }

  get maxConnectionsPerUser(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_MAX_CONNECTIONS_PER_USER', { infer: true });
  }

  get maxQueueEvents(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_MAX_QUEUE_EVENTS', { infer: true });
  }

  get maxDetailIds(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_MAX_DETAIL_IDS', { infer: true });
  }

  get retentionHours(): number {
    return this.config.get('BACKEND_ORDER_REALTIME_RETENTION_HOURS', { infer: true });
  }

  async isStreamEnabledForUser(userId: string): Promise<boolean> {
    if (!this.snapshotEnabled || !this.writesEnabled || !this.streamTransportEnabled) return false;
    if (!(await this.areDatabaseWritesEnabled())) return false;

    const rollout = await this.loadRollout();
    if (!rollout.enabled) return false;
    if (rollout.userIds.includes(userId)) return true;
    return stableCohort(userId) < rollout.rolloutPercent;
  }

  clearRolloutCache(): void {
    this.rolloutCache = null;
    this.writesCache = null;
  }

  async areDatabaseWritesEnabled(): Promise<boolean> {
    if (!this.writesEnabled) return false;
    if (this.writesCache && this.writesCache.expiresAt > Date.now()) {
      return this.writesCache.value.enabled;
    }

    let setting: RealtimeWritesSetting = { enabled: false, maxFanoutOrders: 5000, maxDetailIds: 500 };
    try {
      const result = await this.database.query<RolloutRow>(
        `
        SELECT value_json
        FROM app_settings
        WHERE setting_key = $1 AND is_active = true
        `,
        [WRITES_SETTING_KEY],
      );
      setting = parseWritesSetting(result.rows[0]?.value_json);
    } catch (error) {
      this.logger.warn(`Order realtime writes setting read failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    this.writesCache = { value: setting, expiresAt: Date.now() + CACHE_TTL_MS };
    return setting.enabled;
  }

  private async loadRollout(): Promise<RealtimeRollout> {
    if (this.rolloutCache && this.rolloutCache.expiresAt > Date.now()) {
      return this.rolloutCache.value;
    }

    let rollout = DISABLED_ROLLOUT;
    try {
      const result = await this.database.query<RolloutRow>(
        `
        SELECT value_json
        FROM app_settings
        WHERE setting_key = $1 AND is_active = true
        `,
        [ROLLOUT_SETTING_KEY],
      );
      rollout = parseRollout(result.rows[0]?.value_json);
    } catch (error) {
      this.logger.warn(`Order realtime rollout read failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    this.rolloutCache = { value: rollout, expiresAt: Date.now() + CACHE_TTL_MS };
    return rollout;
  }
}

export function parseRollout(value: unknown): RealtimeRollout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DISABLED_ROLLOUT;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') return DISABLED_ROLLOUT;
  if (
    typeof candidate.rolloutPercent !== 'number' ||
    !Number.isInteger(candidate.rolloutPercent) ||
    candidate.rolloutPercent < 0 ||
    candidate.rolloutPercent > 100
  ) {
    return DISABLED_ROLLOUT;
  }
  if (!Array.isArray(candidate.userIds)) return DISABLED_ROLLOUT;

  const userIds: string[] = [];
  for (const value of candidate.userIds) {
    const normalized = typeof value === 'number' ? String(value) : value;
    if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) return DISABLED_ROLLOUT;
    userIds.push(normalized);
  }

  return {
    enabled: candidate.enabled,
    rolloutPercent: candidate.rolloutPercent,
    userIds: [...new Set(userIds)],
  };
}

export function parseWritesSetting(value: unknown): RealtimeWritesSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { enabled: false, maxFanoutOrders: 5000, maxDetailIds: 500 };
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== 'boolean' ||
    typeof candidate.maxFanoutOrders !== 'number' ||
    !Number.isInteger(candidate.maxFanoutOrders) ||
    candidate.maxFanoutOrders < 1 ||
    candidate.maxFanoutOrders > 100000 ||
    typeof candidate.maxDetailIds !== 'number' ||
    !Number.isInteger(candidate.maxDetailIds) ||
    candidate.maxDetailIds < 1 ||
    candidate.maxDetailIds > 10000
  ) {
    return { enabled: false, maxFanoutOrders: 5000, maxDetailIds: 500 };
  }
  return {
    enabled: candidate.enabled,
    maxFanoutOrders: candidate.maxFanoutOrders,
    maxDetailIds: candidate.maxDetailIds,
  };
}

function stableCohort(userId: string): number {
  const digest = createHash('sha256').update(`order-realtime:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}
