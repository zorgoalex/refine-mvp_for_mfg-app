import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cutPage = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');
const boardPage = readFileSync(fileURLToPath(new URL('../orderStatusBoard/OrderStatusBoardPage.tsx', import.meta.url)), 'utf8');

describe('cut MDF-board card links', () => {
  it('links created machine and bath statuses to an exact board card', () => {
    expect(cutPage).toContain("cardKind: target.kind === 'bath' ? 'bath' : 'packet'");
    expect(cutPage).toContain('cardId: target.cardId');
    expect(cutPage).toContain('cut-job-mdf-board-cell__link');
    expect(boardPage).toContain('data-cnc-card-kind={kind}');
    expect(boardPage).toContain('data-cnc-card-id={cardId}');
    expect(boardPage).toContain("scrollIntoView({ behavior: 'smooth'");
  });

  it('offers forced creation in the list cell only for missing cards', () => {
    expect(cutPage).toContain("state === 'not_created' && canCreate");
    expect(cutPage).toContain('Создать карточку');
    expect(cutPage).toContain("can('cut.manage')");
  });
});
