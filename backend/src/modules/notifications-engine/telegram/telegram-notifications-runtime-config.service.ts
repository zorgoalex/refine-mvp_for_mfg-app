import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface TelegramNotificationsConfig {
  enabled: boolean;
  botToken?: string;
  botUsername?: string;
  webhookSecret?: string;
  apiBase: string;
  requestTimeoutMs: number;
  linkTtlSeconds: number;
  relayOwner: 'none' | 'in_process' | 'external';
  relayPollIntervalMs: number;
  relayBatchSize: number;
  relayWorkerId: string;
  relayMaxAttempts: number;
  relayStaleLockMs: number;
}

@Injectable()
export class TelegramNotificationsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getConfig(): TelegramNotificationsConfig {
    return {
      enabled: this.config.get('BACKEND_ENABLE_TELEGRAM_NOTIFICATIONS', { infer: true }),
      botToken: this.config.get('TELEGRAM_NOTIFICATION_BOT_TOKEN', { infer: true }),
      botUsername: this.config.get('TELEGRAM_NOTIFICATION_BOT_USERNAME', { infer: true }),
      webhookSecret: this.config.get('TELEGRAM_NOTIFICATION_WEBHOOK_SECRET', { infer: true }),
      apiBase: this.config.get('TELEGRAM_NOTIFICATION_API_BASE', { infer: true }),
      requestTimeoutMs: this.config.get('TELEGRAM_NOTIFICATION_REQUEST_TIMEOUT_MS', {
        infer: true,
      }),
      linkTtlSeconds: this.config.get('TELEGRAM_NOTIFICATION_LINK_TTL_SECONDS', {
        infer: true,
      }),
      relayOwner: this.config.get('BACKEND_TELEGRAM_NOTIFICATION_RELAY_OWNER', { infer: true }),
      relayPollIntervalMs: this.config.get(
        'BACKEND_TELEGRAM_NOTIFICATION_RELAY_POLL_INTERVAL_MS',
        { infer: true },
      ),
      relayBatchSize: this.config.get('BACKEND_TELEGRAM_NOTIFICATION_RELAY_BATCH_SIZE', {
        infer: true,
      }),
      relayWorkerId: this.config.get('BACKEND_TELEGRAM_NOTIFICATION_RELAY_WORKER_ID', {
        infer: true,
      }),
      relayMaxAttempts: this.config.get('BACKEND_TELEGRAM_NOTIFICATION_RELAY_MAX_ATTEMPTS', {
        infer: true,
      }),
      relayStaleLockMs: this.config.get(
        'BACKEND_TELEGRAM_NOTIFICATION_RELAY_STALE_LOCK_MS',
        { infer: true },
      ),
    };
  }
}
