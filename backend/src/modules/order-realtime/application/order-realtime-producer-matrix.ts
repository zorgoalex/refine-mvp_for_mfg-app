import type { OrderRealtimeDomain } from './order-realtime.types';

export interface OrderRealtimeProducerMatrixRow {
  writerPaths: readonly string[];
  mutatedTables: readonly string[];
  domains: readonly OrderRealtimeDomain[];
  producer: string;
  noOpRule: string;
  test: string;
}

/**
 * Executable inventory: every runtime path is covered by an explicit command
 * writer or by the narrow statement-level compatibility bridge in migration 098.
 * Bridge rows are transport invalidations, not business commands or audit
 * records. They preserve existing legacy writers during migration and do not
 * authorize new direct Hasura/SQL writes; audit stays owned by each writer.
 */
export const ORDER_REALTIME_PRODUCER_MATRIX: readonly OrderRealtimeProducerMatrixRow[] = [
  {
    writerPaths: [
      'orders create/update/import/transfer',
      'production-actions single/batch/deadline',
      'status-automation',
      'cnc-telegram auto-cut status',
      'Bazis order import',
      'legacy existing direct order detail writers (compatibility only)',
    ],
    mutatedTables: ['order_details'],
    domains: ['detail_status'],
    producer: '098:trg_order_realtime_detail_status_insert/update/delete',
    noOpRule: 'only snapshot-visible old/new rows emit; bridge is not an audit sink',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
  {
    writerPaths: ['order delete/restore'],
    mutatedTables: ['orders'],
    domains: ['detail_status', 'cut_refs'],
    producer: '098:trg_order_realtime_order_visibility_update',
    noOpRule: 'emits only when delete_flag changes',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
  {
    writerPaths: ['cut add/remove/reactivate/reassign item', 'order detail transfer with cut membership'],
    mutatedTables: ['cut_job_item'],
    domains: ['cut_refs'],
    producer: '098:trg_order_realtime_cut_item_insert/update/delete',
    noOpRule: 'only active old/new memberships on visible details and snapshot-visible jobs emit',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
  {
    writerPaths: [
      'cut calculate/manual layout',
      'set current result',
      'cut job archive/restore',
      'cut job rename/profile/layout change',
    ],
    mutatedTables: ['cut_job'],
    domains: ['cut_refs'],
    producer: '098:trg_order_realtime_cut_job_update',
    noOpRule: 'emits only when a snapshot-visible job field changes',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
  {
    writerPaths: ['archive/unarchive cut result'],
    mutatedTables: ['cut_result_archive_state'],
    domains: ['cut_refs'],
    producer: '098:trg_order_realtime_cut_archive_insert/delete',
    noOpRule: 'only archive state for the current snapshot-visible result emits',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
  {
    writerPaths: ['cut profile rename/active/params'],
    mutatedTables: ['cut_param_profiles'],
    domains: ['cut_refs'],
    producer: '098:trg_order_realtime_cut_profile_update',
    noOpRule: 'emits only when name, active state, or params change on a snapshot-visible job',
    test: '098_order_realtime_producer_bridge.test.ts',
  },
] as const;
