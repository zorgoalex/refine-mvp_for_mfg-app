import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const groupEditor = readFileSync(
  new URL('./components/groups/GroupLinksEditor.tsx', import.meta.url),
  'utf8',
);
const groupSelect = readFileSync(
  new URL('./components/groups/GroupSelect.tsx', import.meta.url),
  'utf8',
);
const deadlines = readFileSync(
  new URL('./deadlines/OrderDeadlinePanel.tsx', import.meta.url),
  'utf8',
);

describe('order show lifecycle panels', () => {
  it('owns Groups and Deadlines through explicit panel surfaces', () => {
    expect(show).toContain("<OrderLifecycleReadSurface active={activeInfoPanel === 'groups'}>");
    expect(show).toContain("<OrderLifecycleReadSurface active={activeInfoPanel === 'deadlines'}>");
    expect(show).toContain('<OrderLifecycleReadSurface active={moveModalOpen}>');
  });

  it('guards project-move candidates and write completion by exact resource owner', () => {
    expect(show).toContain('useOrderAsyncReadGuard(moveCandidatesResourceScope)');
    expect(show).toContain('moveCandidatesState?.scopeKey === moveCandidatesScopeKey');
    expect(show).toContain('moveUiState?.scopeKey === moveCandidatesScopeKey');
    expect(show).toContain('moveCandidatesReadGuard.isCurrent(token)');
    expect(show).toContain('const moveToken = moveCandidatesReadGuard.capture()');
    expect(show).toContain('const showToken = showAsyncReadGuard.capture()');
    expect(show).toMatch(/projectsApi\.move\([\s\S]*moveCandidatesReadGuard\.isSameResource\(moveToken\)/);
    expect(show).toMatch(/catch \(error\)[\s\S]*showAsyncReadGuard\.isSameResource\(showToken\)/);
    expect(show).toMatch(/finally[\s\S]*moveCandidatesReadGuard\.isSameResource\(moveToken\)/);
  });

  it('guards and auth-masks group reads, lookups and write completion', () => {
    expect(groupEditor).toContain('useOrderAsyncReadGuard(`order-groups:');
    expect(groupEditor).toContain('groupState?.scopeKey === readScopeKey');
    expect(groupEditor).toContain('readGuard.isCurrent(token)');
    expect(groupEditor).toContain('readGuard.isSameResource(writeToken)');
    expect(groupEditor).toContain('openState?.scopeKey === readScopeKey');
    expect(groupEditor).toContain('<OrderLifecycleReadSurface active={open}>');
    expect(groupSelect).toContain('useOrderAsyncReadGuard(`group-lookup:');
    expect(groupSelect).toContain('itemsState?.scopeKey === readScopeKey');
    expect(groupSelect).toContain('readGuard.isCurrent(token)');
  });

  it('guards and auth-masks deadline reads and override completion', () => {
    expect(deadlines).toContain('useOrderAsyncReadGuard(`order-deadlines:');
    expect(deadlines).toContain('stateEnvelope?.scopeKey === readScopeKey');
    expect(deadlines).toContain('readGuard.isCurrent(token)');
    expect(deadlines).toContain('readGuard.isSameResource(writeToken)');
    expect(deadlines).toContain('overrideUiState?.scopeKey === readScopeKey');
  });
});
