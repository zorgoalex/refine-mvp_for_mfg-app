import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/pages/orderStatusBoard/OrderStatusBoardPage.tsx', 'utf8');
const dialog = readFileSync('src/pages/orderStatusBoard/MdfBathDuplicatesDialog.tsx', 'utf8');
const hybrid = readFileSync('src/pages/orderStatusBoard/mdfHybridBoard.ts', 'utf8');

describe('«Разобрать дубль» wiring guard', () => {
  it('is behind the runtime flag and off in the original board view', () => {
    expect(page).toContain('enabled: featureFlags.mdfBathDuplicates && !cncOriginalView');
    expect(dialog).toContain('if (!enabled) return null;');
  });

  it('shows the badges on bath cards in the standard and the minimal view', () => {
    const view = page.slice(page.indexOf('const CncTelegramBathCardView = memo'),
      page.indexOf("CncTelegramBathCardView.displayName = 'CncTelegramBathCardView';"));
    expect(view.match(/<MdfBathDuplicateBadges bath=\{bath\} \/>/g)).toHaveLength(2);
    expect(dialog).toContain('`Дубль: ${duplicateCount} дет.`');
    expect(dialog).toContain('Переделка: {reworkCount} дет.');
  });

  it('wraps the MDF columns in the context and refreshes both boards after a decision', () => {
    expect(page).toContain('<MdfBathDuplicatesContext.Provider value={bathDuplicatesContext}>');
    expect(page).toContain('onResolved={refreshAfterBathDuplicate}');
    const refresh = page.slice(page.indexOf('const refreshAfterBathDuplicate = useCallback'));
    expect(refresh.slice(0, 300)).toContain('mdfPublishedBoard.refresh()');
    expect(refresh.slice(0, 300)).toContain('fetchInitial({ mutationRefetch: true, preserveLoading: true })');
  });

  it('gates actions on literal cut.manage + orders.view and sends the server digest with an idempotency key', () => {
    expect(page).toContain("const canResolveBathDuplicates = can('cut.manage') && can('orders.view');");
    expect(dialog).toContain('expectedDigest: entry.digest');
    expect(dialog).toContain('orderStatusBoardApi.resolveMdfBathDuplicate(request, attempt.current.key)');
    expect(dialog).toContain('Оставить обе');
    expect(dialog).toContain('Пометить общие детали этой ванны как переделку');
    // The dialog itself never archives or hides (stage 1, plan r7): only a link to «Раскрой».
    expect(dialog).not.toMatch(/archive\(|deleteCutJob|hideBath/);
  });

  it('carries the legacy pair facts onto engine bath cards and reads engine-only baths apart', () => {
    expect(hybrid).toContain('withLegacyBathDuplicates(');
    expect(hybrid).toContain("if (card.kind === 'bath') engineOnlyBathIds.push(card.id);");
    expect(page).toContain('const engineOnlyBathKey = featureFlags.mdfBathDuplicates && mdfHybridBoard');
    expect(page).toContain("const engineBathDuplicatesContext = active ? engineOnlyBathKey : '';");
    // One refresher per page; the id set is its context; refresh signals (poll, legacy read / snapshot timestamps,
    // own decision) only request a read — never a new reader that would drop the one in flight.
    const block = page.slice(page.indexOf('const engineBathDuplicatesCycle ='),
      page.indexOf('const engineBathDuplicates = useMemo'));
    expect(block).toContain('cncToday?.generatedAt');
    expect(block).toContain('mdfHybridSnapshot?.generatedAt');
    expect(block).toContain('bathDuplicatesRevision');
    expect(block).toContain('if (!engineBathDuplicatesRefresherRef.current) {');
    expect(block.match(/createEngineBathDuplicatesRefresher\(/g)).toHaveLength(1);
    expect(block).toContain('setContext(engineBathDuplicatesContext);\n  }, [engineBathDuplicatesContext]);');
    expect(block).toContain('.request();\n  }, [engineBathDuplicatesCycle]);');
    expect(block).toContain('}, CNC_ORDER_STATUS_REFRESH_MS);');
    expect(block).not.toContain('cancelled');
    expect(page).toContain('applyBathDuplicates(mdfHybridBoard.columns, engineBathDuplicates)');
    expect(page).toContain('setBathDuplicatesRevision((revision) => revision + 1);');
  });
});
