import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMdfBoardStatus, forcedMdfCardStorageKind } from './pg-cut-repository';

const row = (overrides: Record<string, unknown> = {}) => ({
  cut_job_id: 42,
  status: 'ready',
  selection_criteria: null,
  active_packet_count: 0,
  hidden_packet_count: 0,
  manual_pending_packet_count: 0,
  active_packets_json: [],
  card_kind: 'machine_file',
  card_id: null,
  target_workday: null,
  ...overrides,
}) as never;

describe('MDF board status projection', () => {
  it('materializes unique order keys once instead of rescanning orders per bath candidate', () => {
    const source = readFileSync(new URL('./pg-cut-repository.ts', import.meta.url), 'utf8');
    const statusQuery = source.slice(
      source.indexOf('async function loadMdfBoardStatuses'),
      source.indexOf('export function buildMdfBoardStatus'),
    );
    expect(statusQuery).toContain('unique_order_keys AS MATERIALIZED');
    expect(statusQuery.match(/JOIN unique_order_keys unique_order/g)).toHaveLength(2);
    expect(statusQuery).not.toContain('FROM orders duplicate_order');
  });

  it('maps a machine-file packet to a clickable target', () => {
    const status = buildMdfBoardStatus(row({
      active_packet_count: 1,
      active_packets_json: [{
        packetId: 'packet-1',
        externalPacketKey: 'erp:1',
        workday: '2026-08-19',
        machine: 'ERP',
        programName: 'Раскрой 42',
        itemCount: 3,
      }],
    }));
    expect(status).toMatchObject({
      state: 'created',
      cardKind: 'machine_file',
      target: { kind: 'machine_file', cardId: 'packet-1', workday: '2026-08-19' },
    });
  });

  it('maps a vacuum result to its own bath target', () => {
    const status = buildMdfBoardStatus(row({
      card_kind: 'bath',
      card_id: 'cut-result:900',
      target_workday: '2026-08-18',
      active_packet_count: 1,
    }));
    expect(status).toMatchObject({
      state: 'created',
      cardKind: 'bath',
      target: { kind: 'bath', cardId: 'cut-result:900', workday: '2026-08-18' },
    });
  });

  it('keeps hidden cards non-clickable and enables ready missing cards', () => {
    expect(buildMdfBoardStatus(row({ card_kind: 'bath', hidden_packet_count: 1 }))).toMatchObject({
      state: 'hidden', target: null, canCreateCard: false,
    });
    expect(buildMdfBoardStatus(row({ card_kind: 'bath' }))).toMatchObject({
      state: 'not_created', target: null, canCreateCard: true,
    });
  });

  it('uses distinct storage kinds and stable conflict-safe insert semantics', () => {
    expect(forcedMdfCardStorageKind('machine_file')).toBe('machine_file');
    expect(forcedMdfCardStorageKind('bath')).toBe('bath_seed');
  });
});
