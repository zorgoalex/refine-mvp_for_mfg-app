import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('./089_notification_channels_telegram.sql', import.meta.url),
  'utf8',
);
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('089 notification channels and Telegram migration', () => {
  it('adds a backward-compatible in-app channel to existing rules', () => {
    expect(sql).toContain(
      `ADD COLUMN IF NOT EXISTS channels_json JSONB NOT NULL DEFAULT '["in_app"]'::jsonb`,
    );
    expect(sql).toContain('chk_notification_rules_channels_nonempty');
  });

  it('creates generic bindings, one-time link tokens and durable deliveries', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notification_channel_bindings');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notification_channel_link_tokens');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS notification_channel_deliveries');
    expect(sql).toContain('idempotency_key TEXT NOT NULL');
    expect(sql).toContain('ADD CONSTRAINT uq_notification_channel_delivery_idempotency');
    expect(sql).toContain('UNIQUE (idempotency_key)');
    expect(sql).toContain("status IN ('pending', 'processing', 'delivered', 'skipped', 'failed', 'unknown')");
    expect(sql).not.toContain('FOR UPDATE');
  });

  it('repairs partial delivery tables and persists the send boundary', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ');
    expect(sql).toContain('ALTER COLUMN idempotency_key SET NOT NULL');
    expect(sql).toContain('ADD CONSTRAINT fk_notification_channel_delivery_user');
  });

  it('deduplicates Telegram webhook update replays', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS telegram_notification_webhook_updates');
    expect(sql).toContain('update_id BIGINT PRIMARY KEY');
  });

  it('has a strict migration-runner end-state probe', () => {
    expect(runner).toContain('089_notification_channels_telegram*)');
    expect(runner).toContain('$(q_col notification_rules channels_json)');
    expect(runner).toContain('$(q_tbl notification_channel_bindings)');
    expect(runner).toContain('$(q_tbl notification_channel_deliveries)');
    expect(runner).toContain('$(q_tbl telegram_notification_webhook_updates)');
    expect(runner).toContain(
      '$(q_col notification_channel_deliveries idempotency_key)',
    );
    expect(runner).toContain(
      '$(q_col notification_channel_deliveries send_started_at)',
    );
    expect(runner).toContain(
      '$(q_con_on notification_channel_deliveries uq_notification_channel_delivery_idempotency)',
    );
    expect(runner).toContain(
      '$(q_con_on notification_channel_deliveries fk_notification_channel_delivery_user)',
    );
  });
});
