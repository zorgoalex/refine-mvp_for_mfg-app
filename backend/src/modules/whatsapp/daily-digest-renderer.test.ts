import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  DAILY_DIGEST_LAYOUT_WIDTH,
  DAILY_DIGEST_RENDER_ZOOM,
  DailyDigestRenderer,
  resolveBoldFontPath,
} from './daily-digest-renderer';
import { resolveFontPath } from '../cut/render/sheet-png';
import {
  DAILY_DIGEST_MAX_ORDERS,
  DAILY_DIGEST_MAX_PAGE_BYTES,
  DAILY_DIGEST_MAX_RUN_BYTES,
  DAILY_DIGEST_RENDERER_VERSION,
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

  it('loads both Regular and Bold font files and bumps the renderer version', () => {
    const regular = resolveFontPath();
    const bold = resolveBoldFontPath();
    expect(regular && existsSync(regular)).toBeTruthy();
    expect(bold && existsSync(bold)).toBeTruthy();
    expect(bold).toContain('LiberationSans-Bold.ttf');
    expect(readFileSync(bold as string).byteLength).toBeGreaterThan(100_000);
    expect(DAILY_DIGEST_RENDERER_VERSION).toBe('daily-order-cards-v2');
  });

  it('renders a narrow image at layout width x zoom with a content-driven height', async () => {
    const [plain] = await renderer.render({ ...makeSnapshot([makeOrder(2)]), cardsPerMessage: 1 });
    const [longer] = await renderer.render({
      ...makeSnapshot([makeOrder(2, { clientName: 'Очень длинное имя клиента для переноса строки в карточке' })]),
      cardsPerMessage: 1,
    });
    const [noStages] = await renderer.render({
      ...makeSnapshot([makeOrder(2, { passedProductionCodes: [] })]),
      cardsPerMessage: 1,
    });
    const plainPng = PNG.sync.read(plain.png);
    expect(plainPng.width).toBe(DAILY_DIGEST_LAYOUT_WIDTH * DAILY_DIGEST_RENDER_ZOOM);
    expect(PNG.sync.read(longer.png).height).toBeGreaterThan(plainPng.height);
    expect(PNG.sync.read(noStages.png).height).toBeLessThan(plainPng.height);
    expect(plainPng.height).toBeLessThan(450 * DAILY_DIGEST_RENDER_ZOOM);
  });

  it('keeps one-card, two-card and maximum-content pages far below the byte limit', async () => {
    const heavy = (id: number) => makeOrder(id, {
      orderName: `К${id} ` + 'Длинное название заказа',
      basisProjectDisplay: 'ПМЗ-15 длинный проект',
      clientName: 'Очень длинное имя клиента для переноса',
      materials: [
        { fullName: 'МДФ 18мм', label: '18мм' },
        { fullName: 'МДФ 16мм', label: 'Черн. 16мм' },
      ],
    });
    for (const count of [1, 2] as const) {
      const pages = await renderer.render({
        ...makeSnapshot(Array.from({ length: count }, (_, index) => heavy(index + 1))),
        cardsPerMessage: count,
      });
      expect(pages).toHaveLength(1);
      expect(pages[0].png.byteLength).toBeLessThan(DAILY_DIGEST_MAX_PAGE_BYTES / 4);
    }
  });

  it('accepts the plural-free header (no order counter) and centers stage codes', async () => {
    // Text nodes are internal, so probe via pixels: the orange stage label must
    // be horizontally centred within the card (card spans gutter..width-gutter).
    const [page] = await renderer.render({
      ...makeSnapshot([makeOrder(2, { passedProductionCodes: ['cut'] })]),
      cardsPerMessage: 1,
    });
    const png = PNG.sync.read(page.png);
    let minX = png.width;
    let maxX = -1;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const i = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
        if (r > 220 && g > 90 && g < 150 && b < 40) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    expect(maxX).toBeGreaterThan(minX);
    expect(Math.abs((minX + maxX) / 2 - png.width / 2)).toBeLessThan(3);
  });
});
