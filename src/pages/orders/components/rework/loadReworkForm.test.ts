import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { OrderReworkState } from '../../../../api/orderReworkApi';
import type { OrderDto } from '../../../../api/types/orderApi.types';
import { createOrderEditBackendPrimaryIdentity } from '../../../../query/orderEditPrimaryResource';
import { getAuthCacheNamespace } from '../../../../query/authCacheNamespace';
import { getOrdersReadBackendMode } from '../../../../query/orderPrimaryResource';
import { featureFlags } from '../../../../config/featureFlags';
import { loadReworkForm, type ReworkFormLoadDependencies } from './loadReworkForm';
import { createReworkFormRefresh, fetchOrderAfterRework } from './useOrderFormReworkPick';
import { reworkStatusesState } from './useReworkOrderStatusIds';
import { redoGroups } from './orderReworkModel';

const rounds = (version: number, over: Partial<OrderReworkState['order']> = {}): OrderReworkState => ({
  order: { orderStatusCode: 'ready', version, canRework: true, productionRound: 1, lastRoundNo: 1, openRoundNo: null, action: 'return', ...over },
  data: [],
});
const order = (version: number, stage = 7): OrderDto => ({
  header: { version } as OrderDto['header'],
  details: [{ id: 11, detailNumber: 1, detailName: 'Фасад', productionStatusId: stage, productionRound: 1 } as OrderDto['details'][number]],
} as OrderDto);

function deps(over: Partial<ReworkFormLoadDependencies> & { roundsSeq?: OrderReworkState[]; orderSeq?: OrderDto[] }): ReworkFormLoadDependencies {
  const roundsSeq = [...(over.roundsSeq ?? [rounds(5)])];
  const orderSeq = [...(over.orderSeq ?? [order(5)])];
  return {
    availability: async () => ({ availability: 'available' }),
    reasons: async () => ({ data: [] }),
    rounds: async () => roundsSeq.length > 1 ? roundsSeq.shift()! : roundsSeq[0],
    getOrder: async () => orderSeq.length > 1 ? orderSeq.shift()! : orderSeq[0],
    isCurrent: () => true,
    ...over,
  };
}

describe('«Переделка»: the rework form opened from a status picker', () => {
  it('opens only when the rounds and the details are one version of the order; a changing order is re-read', async () => {
    // Details read at 5 while the rounds already say 6 (another user moved a stage): never shown together.
    const result = await loadReworkForm(1, deps({ roundsSeq: [rounds(6), rounds(6)], orderSeq: [order(5, 7), order(6, 2)] }));
    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    expect(result.data.state.order.version).toBe(6);
    expect(result.data.details[0].productionStatusId).toBe(2); // the details of version 6, not the stale ones
  });

  it('gives up with a message when the versions keep disagreeing', async () => {
    const result = await loadReworkForm(1, deps({ roundsSeq: [rounds(6)], orderSeq: [order(5)], attempts: 3 }));
    expect(result).toEqual({ kind: 'message', level: 'warning', text: 'Заказ сейчас меняется — повторите через минуту' });
  });

  it('a superseded load (a newer request or a close) shows nothing, whatever arrives later', async () => {
    let current = true;
    const pending = loadReworkForm(1, deps({
      rounds: async () => { current = false; return rounds(5); }, // the user picked another order meanwhile
      isCurrent: () => current,
    }));
    expect(await pending).toEqual({ kind: 'stale' });
  });

  it('explains why the form does not open', async () => {
    expect(await loadReworkForm(1, deps({ availability: async () => ({ availability: 'disabled_flag' }) })))
      .toEqual({ kind: 'message', level: 'warning', text: 'Переделка заказов выключена' });
    expect(await loadReworkForm(1, deps({ roundsSeq: [rounds(5, { canRework: false })] })))
      .toMatchObject({ kind: 'message', text: 'Нет права изменять этот заказ' });
    expect(await loadReworkForm(1, deps({ roundsSeq: [rounds(5, { action: null })] })))
      .toMatchObject({ kind: 'message', text: 'Для заказа в этом статусе переделка недоступна' });
  });

  it('after the command the order is read directly and replaces only an older cache entry', async () => {
    const queryClient = new QueryClient();
    const key = createOrderEditBackendPrimaryIdentity({
      orderId: 42,
      authCacheNamespace: getAuthCacheNamespace(getOrdersReadBackendMode(featureFlags.useBackendOrdersRead)),
    }).queryKey;
    queryClient.setQueryData(key, order(5)); // fresh within its 15 s stale window
    expect((await fetchOrderAfterRework(42, { queryClient, getOrderById: async () => order(6, 2) })).header.version).toBe(6);
    expect((queryClient.getQueryData(key) as OrderDto).header.version).toBe(6);
    queryClient.setQueryData(key, order(8)); // a newer one already cached: a late read does not roll it back
    await fetchOrderAfterRework(42, { queryClient, getOrderById: async () => order(7) });
    expect((queryClient.getQueryData(key) as OrderDto).header.version).toBe(8);
  });

  it('two commands in a row: the first refresh, answering late with the older version, never publishes', async () => {
    const published: number[] = [];
    let releaseFirst: (value: OrderDto) => void = () => {};
    const reads = [
      new Promise<OrderDto>((resolve) => { releaseFirst = resolve; }), // the read after command 1 hangs
      Promise.resolve(order(7)), // the read after command 2
    ];
    const refresh = createReworkFormRefresh({
      getOrder: () => reads.shift()!,
      isClean: () => true,
      publish: (dto) => published.push(Number(dto.header.version)),
    });
    const first = refresh(1, 6);
    const second = refresh(1, 7);
    expect(await second).toBe('published');
    releaseFirst(order(6));
    expect(await first).toBe('superseded');
    expect(published).toEqual([7]);
  });

  it('a refresh answering a version older than its command, or into a form with new edits, publishes nothing', async () => {
    const published: number[] = [];
    const stale = createReworkFormRefresh({ getOrder: async () => order(5), isClean: () => true, publish: (d) => published.push(Number(d.header.version)) });
    expect(await stale(1, 6)).toBe('stale');
    const dirty = createReworkFormRefresh({ getOrder: async () => order(6), isClean: () => false, publish: (d) => published.push(Number(d.header.version)) });
    expect(await dirty(1, 6)).toBe('dirty');
    expect(published).toEqual([]);
  });

  it('a status picker applies nothing until the status reference is loaded — also after a failed load', () => {
    const rows = [{ order_status_id: 10, order_status_code: 'rework' }, { order_status_id: 3, order_status_code: 'ready' }];
    expect(reworkStatusesState({ rows, isLoading: false, isError: false })).toEqual({ ids: new Set([10]), ready: true });
    expect(reworkStatusesState({ rows: undefined, isLoading: true, isError: false }).ready).toBe(false);
    expect(reworkStatusesState({ rows: undefined, isLoading: false, isError: true }).ready).toBe(false);
  });

  it('the outcome is per actual «redo from»: a per-detail choice is its own group', () => {
    const rows = [
      { id: 1, detailNumber: 1, name: '', productionStatusId: 7, productionRound: 1 },
      { id: 2, detailNumber: 2, name: '', productionStatusId: 7, productionRound: 1 },
      { id: 3, detailNumber: 3, name: '', productionStatusId: 7, productionRound: 1 },
    ];
    expect(redoGroups(rows, { 2: 2 }, 7).map((g) => [g.redoFrom, g.details.map((d) => d.id)])).toEqual([[7, [1, 3]], [2, [2]]]);
    expect(redoGroups(rows, {}, undefined)).toEqual([]);
  });
});
