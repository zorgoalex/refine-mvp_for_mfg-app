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

  it('switches between create and delete actions for bath cards', () => {
    expect(cutPage).toContain('{canCreate ? (');
    expect(cutPage).toContain('Создать карточку');
    expect(cutPage).toContain("state === 'created' && canDelete");
    expect(cutPage).toContain('Удалить карточку');
    expect(cutPage).toContain('cutApi.deleteMdfBoardCard(targetJob.cutJobId, expectedCutResultId)');
    expect(cutPage).toContain("can('cut.manage')");
  });
});
