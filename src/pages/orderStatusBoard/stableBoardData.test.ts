import { describe, expect, it } from 'vitest';
import type { CncTelegramTodayColumn } from '../../api/types/cncTelegramApi.types';
import type { OrderStatusBoardColumn } from '../../api/types/orderStatusBoardApi.types';
import {
  reuseIfSameData,
  reuseUnchangedCncColumns,
  reuseUnchangedOrderBoardColumns,
  reuseUnchangedMap,
  reuseUnchangedOrderEntries,
  orderStatusOptionColumns,
} from './stableBoardData';

const packet = (id: string, status = 'parsed') => ({ packetId: id, completionStatus: status, items: [{ q: 1 }] }) as never;
const bath = (id: string, ready = false) => ({ bathCardId: id, ready, items: [] }) as never;
const column = (key: string, packets: never[], baths: never[] = []): CncTelegramTodayColumn =>
  ({ key, title: key, total: packets.length + baths.length, packets, baths, bazisCutSets: [] }) as never;

describe('stable board data', () => {
  it('keeps unchanged cards and columns, replaces only the changed card', () => {
    const before = [column('parsed', [packet('a'), packet('b')]), column('baths', [], [bath('x')])];
    const fresh = [column('parsed', [packet('a'), packet('b', 'completed')]), column('baths', [], [bath('x')])];
    const after = reuseUnchangedCncColumns(before, fresh);
    expect(after[0].packets[0]).toBe(before[0].packets[0]);
    expect(after[0].packets[1]).not.toBe(before[0].packets[1]);
    expect(after[0].packets[1]).toBe(fresh[0].packets[1]);
    expect(after[1]).toBe(before[1]);
    expect(after).not.toBe(before);
  });

  it('returns the previous columns when nothing changed, and follows moves between columns', () => {
    const before = [column('parsed', [packet('a')]), column('completed', [])];
    expect(reuseUnchangedCncColumns(before, [column('parsed', [packet('a')]), column('completed', [])])).toBe(before);
    const moved = reuseUnchangedCncColumns(before, [column('parsed', []), column('completed', [packet('a')])]);
    expect(moved[0].packets).toEqual([]);
    expect(moved[1].packets[0]).toEqual(before[0].packets[0]);
    expect(moved[1].total).toBe(1);
    expect(reuseUnchangedCncColumns(null, before)).toBe(before);
  });

  it('accepts columns without BASIS sets (older backend) and refreshes them again', () => {
    const legacy = (packets: never[]) => ({ key: 'parsed', title: 'p', total: packets.length, packets, baths: [] }) as never;
    const before = reuseUnchangedCncColumns(null, [legacy([packet('a')])]);
    const same = reuseUnchangedCncColumns(before, [legacy([packet('a')])]);
    expect(same).toBe(before);
    const changed = reuseUnchangedCncColumns(same, [legacy([packet('a', 'completed')])]);
    expect(changed[0].bazisCutSets).toBeUndefined();
    expect(changed[0].packets[0]).not.toBe(before[0].packets[0]);
  });

  it('keeps unchanged order cards', () => {
    const card = (orderId: number, name: string) => ({ orderId, orderName: name }) as never;
    const col = (cards: never[]): OrderStatusBoardColumn =>
      ({ key: 'c', status: { id: 1 }, total: cards.length, cards, nextCursor: null }) as never;
    const before = [col([card(1, 'A'), card(2, 'B')])];
    expect(reuseUnchangedOrderBoardColumns(before, [col([card(1, 'A'), card(2, 'B')])])).toBe(before);
    const after = reuseUnchangedOrderBoardColumns(before, [col([card(1, 'A'), card(2, 'B2')])]);
    expect(after[0].cards[0]).toBe(before[0].cards[0]);
    expect(after[0].cards[1]).not.toBe(before[0].cards[1]);
  });

  it('keeps an equal plain map (manual moves, card locations)', () => {
    const moves = { 'packet:a': 'completed' };
    expect(reuseIfSameData(moves, { 'packet:a': 'completed' })).toBe(moves);
    const next = { 'packet:a': 'parsed' };
    expect(reuseIfSameData(moves, next)).toBe(next);
    const empty = {};
    expect(reuseIfSameData(empty, {})).toBe(empty);
    expect(reuseIfSameData(null, next)).toBe(next);
  });

  it('keeps unchanged order entries, comparing readiness maps by content', () => {
    const entry = (orderId: number, cut: number) => ({ card: { orderId }, readiness: {
      totalDetails: 2, cutDetails: cut, positionQuantities: new Map([['1:1', { cut, rolled: 0 }]]) }, missingDetails: [] });
    const before = { orders: [entry(1, 1), entry(2, 0)], orders_ready: [] };
    const after = reuseUnchangedOrderEntries(before, { orders: [entry(1, 1), entry(2, 0)], orders_ready: [] });
    expect(after.orders[0]).toBe(before.orders[0]);
    expect(after.orders[1]).toBe(before.orders[1]);
    const changedMap = { orders: [entry(1, 1), { ...entry(2, 0), readiness: { ...entry(2, 0).readiness,
      positionQuantities: new Map([['1:1', { cut: 2, rolled: 0 }]]) } }], orders_ready: [] };
    const next = reuseUnchangedOrderEntries(after, changedMap);
    expect(next.orders[0]).toBe(before.orders[0]);
    expect(next.orders[1]).toBe(changedMap.orders[1]); // only the Map differs
  });

  it('keeps the card-gate map while no gate changed; a new command token or mode is a change', () => {
    const gate = (token: string | null) => ({ movable: Boolean(token), commandToken: token, blockedReason: null });
    const before = new Map([['packet:a', gate('t1')], ['bath:b', gate(null)]]);
    expect(reuseUnchangedMap(before, new Map([['packet:a', gate('t1')], ['bath:b', gate(null)]]))).toBe(before);
    const after = reuseUnchangedMap(before, new Map([['packet:a', gate('t2')], ['bath:b', gate(null)]]));
    expect(after).not.toBe(before);
    expect(after.get('bath:b')).toBe(before.get('bath:b'));
    expect(after.get('packet:a')?.commandToken).toBe('t2');
  });

  it('gives order cards status options that do not change when only cards move', () => {
    const column = (cards: number[]) => ({ key: 'c', status: { id: 1, name: 'Новый', isActive: true }, total: cards.length,
      cards: cards.map((orderId) => ({ orderId })), nextCursor: null }) as never;
    const first = orderStatusOptionColumns(null, [column([1, 2])]);
    expect(first[0].cards).toEqual([]);
    expect(orderStatusOptionColumns(first, [column([1])])).toBe(first);
  });
});
