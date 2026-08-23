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
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('transition: all');
  });
});
