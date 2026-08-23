import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('./MdfBoardHistoryPanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./orderStatusBoard.css', import.meta.url), 'utf8');

describe('MdfBoardHistoryPanel UX guards', () => {
  it('keeps search, diagnosis and causal episodes in the lower board panel', () => {
    expect(panel).toContain('История МДФ-доски');
    expect(panel).toContain('searchMdfBoardHistoryOrders');
    expect(panel).toContain('Почему сейчас здесь');
    expect(panel).toContain('diagnosis.blockers');
    expect(panel).toContain('history.episodes.map');
    expect(panel).toContain('Связанные изменения:');
    expect(panel).toContain('Показать карточку на доске');
    expect(panel).toContain('С создания заказа');
    expect(panel).not.toContain('Последние 2 месяца');
  });

  it('has responsive, accessible interaction and reduced-motion treatment', () => {
    expect(css).toContain('.mdf-history');
    expect(css).toContain('.mdf-history--collapsed');
    expect(css).toContain('height: clamp(210px, 30dvh, 320px)');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('transition: all');
  });

  it('can close and collapse without hiding the board behind unbounded content', () => {
    expect(panel).toContain('aria-label="Закрыть историю"');
    expect(panel).toContain("collapsed ? 'Развернуть историю' : 'Свернуть историю'");
    expect(panel).toContain('onCollapsedChange(!collapsed)');
    expect(panel).toContain('<div className="mdf-history__body">');
  });

  it('shows order numbers without project codes in the search field', () => {
    expect(panel).toContain('<span>{order.orderName}</span>');
    expect(panel).not.toContain('<span>{order.fullNumber}</span>');
    expect(panel).toContain('placeholder="Номер заказа"');
  });

  it('invalidates an in-flight history request when the order is cleared', () => {
    expect(panel).toMatch(/if \(selectedOrderId === null\) \{\s*\+\+historyRevision\.current;\s*setHistory\(null\);\s*setLoading\(false\);/);
  });
});
