import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(
  'src/pages/orderStatusBoard/OrderStatusBoardPage.tsx',
  'utf8',
);
const css = readFileSync(
  'src/pages/orderStatusBoard/orderStatusBoard.css',
  'utf8',
);
const interaction = readFileSync(
  'src/pages/orderStatusBoard/interaction.ts',
  'utf8',
);

describe('OrderStatusBoardPage UX guards', () => {
  it('keeps keyboard move, live announcements and focus restoration', () => {
    expect(page).toContain('aria-label={`Переместить заказ');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('aria-describedby');
    expect(page).toContain('restoreOrderStatusBoardFocus');
    expect(page).toContain('data-status-board-order-id');
  });

  it('keeps production auto-mode side effects behind explicit confirmation', () => {
    expect(interaction).toContain('productionStatusFromDetailsEnabled');
    expect(page).toContain('Перевести заказ в ручной режим?');
    expect(page).toContain('отключит авторасчёт');
    expect(interaction).toContain('if (!confirmed)');
  });

  it('keeps mobile drag-free and respects reduced motion', () => {
    expect(page).toContain("window.matchMedia('(pointer: fine)')");
    expect(page).toContain('canDrag: moveAvailable && finePointer');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('scroll-snap-type: x mandatory');
  });

  it('keeps the upper scrollbar synchronized with the board viewport', () => {
    expect(page).toContain('topScrollbarTrack.style.width');
    expect(page).toContain('scrollBoardFromTop');
    expect(page).toContain('scrollTopFromBoard');
    expect(page).toContain('aria-controls="status-board-viewport"');
    expect(css).toContain('.status-board-scrollbar');
    expect(css).toContain('overflow-x: auto');
  });

  it('uses the application currency instead of a hardcoded foreign currency', () => {
    expect(page).toContain('currency: CURRENCY_CODE');
    expect(page).not.toContain("currency: 'RUB'");
  });

  it('shows the completed-status opt-in only on the production tab with a usable hit area', () => {
    expect(page).toContain("viewState.view === 'production'");
    expect(page).toContain('Показывать завершённые');
    expect(page).toContain('showDone: event.target.checked');
    expect(css).toContain('.status-board-toolbar__checkbox');
    expect(css).toContain('min-height: 40px');
  });

  it('keeps CNC work as a separate visual flow and API contract', () => {
    expect(page).toContain('cncTelegram: featureFlags.cncTelegram');
    expect(page).toContain("key: 'cnc_today'");
    expect(page).toContain('cncTelegramApi.today');
    expect(page).toContain('workday ? { date: workday } : {}');
    expect(page).toContain('<CncTelegramTodayColumns');
    expect(page).toContain('CNC_HISTORY_DAYS = 7');
    expect(page).toContain('aria-label="Дата CNC-работ"');
    expect(page).toContain('В чате {formatDateTime');
    expect(page).toContain('<Collapse.Panel');
    expect(page).not.toContain('items={[{');
    expect(page).not.toContain("board: 'cnc");
  });
});
