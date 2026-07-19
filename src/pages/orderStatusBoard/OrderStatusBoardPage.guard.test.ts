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

  it('uses the application currency instead of a hardcoded foreign currency', () => {
    expect(page).toContain('currency: CURRENCY_CODE');
    expect(page).not.toContain("currency: 'RUB'");
  });
});
