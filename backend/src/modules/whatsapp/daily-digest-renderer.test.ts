import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { DailyDigestRenderer } from './daily-digest-renderer';
import {
  DAILY_DIGEST_MAX_ORDERS,
  DAILY_DIGEST_MAX_PAGE_BYTES,
  DAILY_DIGEST_MAX_RUN_BYTES,
  type DailyDigestOrderCard,
  type DailyDigestSnapshot,
} from './daily-digest-snapshot.types';

const makeOrder = (orderId: number, patch: Partial<DailyDigestOrderCard> = {}): DailyDigestOrderCard => ({
  orderId,
  orderName: String(2900 + orderId),
  orderDate: '2026-09-22',
  plannedCompletionDate: '2026-09-23',
  clientName: 'ТОО Мебель & Дом',
  orderStatusName: 'В работе',
  paymentStatusName: 'Оплачен',
  totalArea: orderId + 0.25,
  basisProjectDisplay: orderId === 1 ? 'ПМЗ-15 <A>' : null,
  materials: [{ fullName: 'МДФ 18мм', label: '18мм' }],
  millingDisplay: 'Фрезеровка',
  passedProductionCodes: ['cut', 'custom'],
  ...patch,
});

const makeSnapshot = (orders: DailyDigestOrderCard[]): DailyDigestSnapshot => ({
  businessDate: '2026-09-23',
  rendererVersion: 'daily-order-cards-test',
  totalArea: orders.reduce((sum, order) => sum + order.totalArea, 0),
  cardsPerMessage: 2,
  orders,
  workflowDisplay: {
    displayOrderCodes: ['custom', 'cut'],
    codeToLetter: { custom: 'Я', cut: 'Р' },
    codeToName: { custom: 'Сборка', cut: 'Распилен' },
  },
});

describe('DailyDigestRenderer', () => {
  const renderer = new DailyDigestRenderer();

  it('returns no image for an empty day', async () => {
    expect(await renderer.render(makeSnapshot([]))).toEqual([]);
  });

  it.each([1, 2, 3])('renders %i cards with two cards per image and stable IDs', async (count) => {
    const pages = await renderer.render(makeSnapshot(
      Array.from({ length: count }, (_, index) => makeOrder(index + 1)),
    ));

    expect(pages.map((page) => page.orderIds)).toEqual(
      count <= 2 ? [Array.from({ length: count }, (_, index) => index + 1)] : [[1, 2], [3]],
    );
    expect(pages.map((page) => page.pageIndex)).toEqual(pages.map((_, index) => index + 1));
    for (const page of pages) {
      expect(page.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  });

  it('puts the whole-day header only on the first image', async () => {
    const pages = await renderer.render(makeSnapshot(
      Array.from({ length: 4 }, (_, index) => makeOrder(index + 1)),
    ));
    const first = PNG.sync.read(pages[0].png);
    const second = PNG.sync.read(pages[1].png);
    expect(first.height).toBeGreaterThan(second.height);
  });

  it('uses the frozen cards-per-message value while keeping the whole-day header on page one', async () => {
    const orders = Array.from({ length: 3 }, (_, index) => makeOrder(index + 1));
    const twoPerMessage = await renderer.render(makeSnapshot(orders));
    const oneCardSnapshot = { ...makeSnapshot(orders), cardsPerMessage: 1 as const };
    const onePerMessage = await renderer.render(oneCardSnapshot);
    const changedAggregate = await renderer.render({ ...oneCardSnapshot, totalArea: 99.99 });

    expect(twoPerMessage.map((page) => page.orderIds)).toEqual([[1, 2], [3]]);
    expect(onePerMessage.map((page) => page.orderIds)).toEqual([[1], [2], [3]]);
    expect(PNG.sync.read(onePerMessage[0].png).height).toBeGreaterThan(PNG.sync.read(onePerMessage[1].png).height);
    expect(makeSnapshot(orders).totalArea).toBe(6.75);
    expect(changedAggregate[0].png.equals(onePerMessage[0].png)).toBe(false);
    expect(changedAggregate[1].png.equals(onePerMessage[1].png)).toBe(true);
  });

  it('caps 500 orders without truncating and enforces the per-page/run byte contracts', async () => {
    const orders = Array.from({ length: DAILY_DIGEST_MAX_ORDERS }, (_, index) => makeOrder(index + 1));
    const pages = await renderer.render({ ...makeSnapshot(orders), cardsPerMessage: 1 });
    expect(pages).toHaveLength(500);
    expect(pages[0].orderIds).toEqual([1]);
    expect(pages.at(-1)?.orderIds).toEqual([500]);
    expect(pages.every((page) => page.png.byteLength <= DAILY_DIGEST_MAX_PAGE_BYTES)).toBe(true);
    expect(pages.reduce((total, page) => total + page.png.byteLength, 0)).toBeLessThanOrEqual(DAILY_DIGEST_MAX_RUN_BYTES);
  }, 30_000);

  it('escapes XML content, wraps long fields, and uses frozen workflow letters', async () => {
    const [page] = await renderer.render(makeSnapshot([makeOrder(1, {
      orderName: 'Заказ & <премиум> "А"',
      clientName: 'Очень длинный клиентский заказчик с unicode символами — Алматы',
      passedProductionCodes: ['cut', 'custom'],
    })]));

    expect(page?.png.byteLength).toBeGreaterThan(1000);
    expect(page?.orderIds).toEqual([1]);
  });

  it('writes a visual review fixture with long Cyrillic text under worktree/testtmp', async () => {
    const fixturePath = fileURLToPath(new URL('../../../../testtmp/daily-order-cards-preview.png', import.meta.url));
    await mkdir(dirname(fixturePath), { recursive: true, mode: 0o700 });
    const snapshot = makeSnapshot([
      makeOrder(1, { totalArea: 2.75, clientName: 'ТОО «Мебельный Дом Алматы» — производственный заказчик' }),
      makeOrder(2, { totalArea: 1.25, orderStatusName: 'Готов к выдаче', paymentStatusName: 'Не оплачен' }),
      makeOrder(3, { totalArea: 4.5, orderStatusName: 'Выдан', basisProjectDisplay: 'ПМЗ-15 <A>' }),
    ]);
    // Deliberately separate the header aggregate from page one's card subtotal.
    snapshot.totalArea = 38.63;
    const [page] = await renderer.render(snapshot);
    await writeFile(fixturePath, page.png, { mode: 0o600 });
    expect(page.orderIds).toEqual([1, 2]);
  });

  it('fails clearly instead of clipping content beyond bounded card layout', async () => {
    const snapshot = makeSnapshot([makeOrder(1, {
      clientName: 'клиент '.repeat(100),
    })]);
    await expect(renderer.render(snapshot)).rejects.toMatchObject({
      code: 'DAILY_DIGEST_CONTENT_TOO_LARGE',
    });
  });

  it('rejects snapshots above the order cap and invalid area totals', async () => {
    const tooMany = makeSnapshot(Array.from({ length: DAILY_DIGEST_MAX_ORDERS + 1 }, (_, index) => makeOrder(index + 1)));
    await expect(renderer.render(tooMany)).rejects.toMatchObject({
      code: 'DAILY_DIGEST_ORDER_LIMIT_EXCEEDED',
    });
    await expect(renderer.render({ ...makeSnapshot([]), totalArea: Number.NaN })).rejects.toMatchObject({
      code: 'DAILY_DIGEST_SNAPSHOT_INVALID',
    });
    await expect(renderer.render({ ...makeSnapshot([]), cardsPerMessage: 3 as 1 | 2 })).rejects.toMatchObject({
      code: 'DAILY_DIGEST_SNAPSHOT_INVALID',
    });
  });
});
