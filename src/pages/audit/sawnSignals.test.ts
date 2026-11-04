import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../../api/apiRoutes';
import { createCncSawnIdempotencyKey } from '../../api/cncSawnSignalsApi';
import { withQuery } from '../../api/ordersApi';
import type { CncSawnApplyPreviewItem, CncSawnApplyState } from '../../api/types/cncSawnSignals.types';
import {
  buildSawnConfirmItems,
  buildSawnSignalsQuery,
  sawnEligibleIds,
  sawnReactorText,
  SAWN_APPLY_STATE_LABELS,
  SAWN_BLOCKED_REASON_LABELS,
} from './sawnSignals';

const STATES: CncSawnApplyState[] = ['pending', 'held_disabled', 'held_baseline', 'held_history',
  'held_return_barrier', 'held_engine', 'retry_wait', 'failed_final', 'applied', 'already_completed', 'closed'];

function previewItem(id: number, eligible: boolean): CncSawnApplyPreviewItem {
  return {
    packetSignalId: id, packetId: `p${id}`, cuttingSequenceNo: id, applyState: 'held_baseline', eligible,
    blockedReason: eligible ? null : 'closed', effect: { details: [], orders: [], events: [] }, effectDigest: `d${id}`,
  };
}

describe('sawn signals UI helpers', () => {
  it('has a Russian label for every apply state and blocked reason', () => {
    for (const state of STATES) expect(SAWN_APPLY_STATE_LABELS[state]).toMatch(/[А-Яа-яЁё]/);
    expect(Object.keys(SAWN_APPLY_STATE_LABELS).sort()).toEqual([...STATES].sort());
    for (const reason of ['stale_observation', 'closed', 'return_barrier', 'engine_mode', 'already_completed', 'already_applied', 'read_only'] as const) {
      expect(SAWN_BLOCKED_REASON_LABELS[reason]).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('builds the list query and drops empty filters', () => {
    expect(buildSawnSignalsQuery({})).toEqual({
      from: undefined, to: undefined, cuttingSequenceNo: undefined, applyState: undefined, openOnly: undefined, page: 1, pageSize: 50,
    });
    const query = buildSawnSignalsQuery({
      period: [dayjs('2026-11-01'), dayjs('2026-11-04')], cuttingSequenceNo: '391', applyState: 'held_disabled', openOnly: true,
    }, 2, 25);
    expect(query).toMatchObject({ cuttingSequenceNo: 391, applyState: 'held_disabled', openOnly: true, page: 2, pageSize: 25 });
    expect(query.from).toBe(dayjs('2026-11-01').startOf('day').toISOString());
    expect(buildSawnSignalsQuery({ cuttingSequenceNo: 'abc' }).cuttingSequenceNo).toBeUndefined();
    const url = withQuery(apiRoutes.cncTelegram.sawnSignals, buildSawnSignalsQuery({ openOnly: true, cuttingSequenceNo: 5 }));
    expect(url).toContain('/cnc-telegram/sawn-signals?');
    expect(url).toContain('openOnly=true');
    expect(url).toContain('cuttingSequenceNo=5');
    expect(url).not.toContain('applyState');
  });

  it('routes match the contract paths', () => {
    expect(apiRoutes.cncTelegram.sawnSignalSettings).toMatch(/\/cnc-telegram\/sawn-signals\/settings$/);
    expect(apiRoutes.cncTelegram.sawnSignalsApplyPreview).toMatch(/\/cnc-telegram\/sawn-signals\/apply-pending\/preview$/);
    expect(apiRoutes.cncTelegram.sawnSignalsApplyConfirm).toMatch(/\/cnc-telegram\/sawn-signals\/apply-pending\/confirm$/);
  });

  it('shows hidden reactors as hidden by Telegram', () => {
    expect(sawnReactorText(null)).toBe('скрыто Telegram');
    expect(sawnReactorText({ peerType: 'user', peerId: '1', displayName: 'Иван', username: 'ivan' })).toBe('Иван (@ivan)');
    expect(sawnReactorText({ peerType: 'user', peerId: '1', displayName: null, username: 'ivan' })).toBe('@ivan');
  });

  it('confirms only eligible and still-selected items with their digests', () => {
    const items = [previewItem(1, true), previewItem(2, false), previewItem(3, true)];
    expect(sawnEligibleIds(items)).toEqual([1, 3]);
    expect(buildSawnConfirmItems(items, [1, 2, 3])).toEqual([
      { packetSignalId: 1, effectDigest: 'd1' }, { packetSignalId: 3, effectDigest: 'd3' },
    ]);
    expect(buildSawnConfirmItems(items, [3])).toEqual([{ packetSignalId: 3, effectDigest: 'd3' }]);
    expect(buildSawnConfirmItems(items, [])).toEqual([]);
  });

  it('generates idempotency keys within the contract bounds (8..128)', () => {
    const a = createCncSawnIdempotencyKey();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(createCncSawnIdempotencyKey()).not.toBe(a);
  });

  it('wires the tab, permission gating and settings switch (source guard)', () => {
    const audit = readFileSync(join(__dirname, 'TelegramWorkerAudit.tsx'), 'utf8');
    const tab = readFileSync(join(__dirname, 'TelegramSawnSignals.tsx'), 'utf8');
    const config = readFileSync(join(__dirname, '../configuration/components/StatusAutomationConfig.tsx'), 'utf8');
    expect(audit).toContain("key: 'sawn-signals', label: 'Сигналы «Распилено»'");
    expect(audit).not.toMatch(/can\([^)]*\)\s*\?\s*\[\s*\{\s*key: 'sawn-signals'/);
    expect(tab).toContain("can('cut.manage')");
    expect(tab).toContain('{canManage && <Button onClick={() => setApplyOpen(true)}>Применить накопленные…</Button>}');
    expect(tab).toContain('скрыто Telegram');
    expect(tab).toContain('≈ при наблюдении');
    expect(tab).toContain('поздний');
    expect(config).toContain('Переносить файл в «Распилено» по 👍 из чата');
    expect(config).toContain("can('cut.manage')");
    expect(config).toContain('cncSawnSignalsApi.settings()');
  });
});
