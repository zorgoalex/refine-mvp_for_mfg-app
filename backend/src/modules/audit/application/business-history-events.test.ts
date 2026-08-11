import { describe, expect, it } from 'vitest';
import { isBusinessHistoryEvent } from './business-history-events';

describe('business history event catalog', () => {
  it('classifies current domain audit events as business history', () => {
    [
      'orders.update',
      'orders.detail_transfer',
      'payments.create',
      'production.stage_activated',
      'deadline.order_override_updated',
      'cut_job.calculated',
      'cut_config.param_profile_upserted',
      'bazis.order_details_added',
      'bazis_cut_set.created',
      'bazis_pdf_table_pattern.updated',
      'client_phones.update',
      'detail_labels.generated',
      'doweling.created',
      'mdf.order_machine_files_present',
      'mdf_board.manual_move.deleted',
      'export_template.created',
      'export_template.updated',
      'export_template.deleted',
      'export_template.default_changed',
      'label_ocr_template.updated',
      'label_qr_template.created',
      'label_template.deleted',
      'order_label_data.updated',
      'order_labels.generated',
      'users.create',
      'project.order_moved',
      'groups.participants_changed',
      'org.direction_head_added',
      'ORG_DIRECTION_CREATED',
      'notification.rule_updated',
      'status_automation.rule_applied',
      'crm_sync.upsert',
      'vlm.analyze',
      'DEADLINE_TRANSITION_RULE_UPDATED',
    ].forEach((event) => expect(isBusinessHistoryEvent(event), event).toBe(true));
  });

  it('excludes technical, auth, worker, denied and read diagnostics', () => {
    [
      'auth.login.success',
      'auth.refresh.reuse_detected',
      'cnc.telegram_worker.audit_write_denied',
      'cnc.telegram_packet.ingested',
      'telegram_notification_delivery_batch_finished',
      'outbox_relay_scheduler_tick_failed',
      'deadline_worker_batch_finished',
      'crm_sync_scheduler_tick_skipped',
      'payment.permission_denied',
      'export_template.permission_denied',
      'status_automation.rule_view_denied',
      'orders.status_board.read',
      'unknown.future_event',
    ].forEach((event) => expect(isBusinessHistoryEvent(event), event).toBe(false));
  });
});
