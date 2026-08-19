import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cutPage = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');
const boardPage = readFileSync(new URL('../orderStatusBoard/OrderStatusBoardPage.tsx', import.meta.url), 'utf8');
const boardModel = readFileSync(new URL('../orderStatusBoard/model.ts', import.meta.url), 'utf8');

describe('cut-list MDF board card UX', () => {
  it('creates missing cards and builds permission-aware exact-card links', () => {
    expect(cutPage).toContain('cncTelegramApi.createMdfCard');
    expect(cutPage).toContain('Создать карточку');
    expect(cutPage).toContain('canOpenBoard={canViewOrders}');
    expect(cutPage).toContain("cardKind: target.kind === 'bath' ? 'bath' : 'packet'");
    expect(cutPage).toContain("cardId: target.cardId");
    expect(cutPage).toContain("date: target.workday");
  });

  it('preserves deep-link URL state and focuses the exact rendered card', () => {
    expect(boardModel).toContain("cncCardKind?: 'packet' | 'bath'");
    expect(boardModel).toContain("params.set('cardId', state.cncCardId)");
    expect(boardPage).toContain('data-cnc-card-kind={kind}');
    expect(boardPage).toContain('data-cnc-card-id={cardId}');
    expect(boardPage).toContain("target.scrollIntoView({ behavior: 'smooth'");
    expect(boardPage).toContain("target.classList.add('cnc-board-card-shell--deep-linked')");
  });
});
