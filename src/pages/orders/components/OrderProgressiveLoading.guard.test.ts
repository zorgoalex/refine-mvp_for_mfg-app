import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(resolve(__dirname, '../list.tsx'), 'utf8');
const showSource = readFileSync(resolve(__dirname, '../show.tsx'), 'utf8');
const formSource = readFileSync(resolve(__dirname, 'OrderForm.tsx'), 'utf8');
const progressiveSource = readFileSync(resolve(__dirname, 'OrderProgressiveLoading.tsx'), 'utf8');

describe('order progressive loading integration guards', () => {
  it('keeps list rows mounted and removes Ant table/card blocking overlays during refresh', () => {
    expect(listSource).toContain('<OrderListProgressiveSurface');
    expect(listSource).toContain('state={orderListLoading}');
    expect(listSource.match(/loading=\{false\}/g)).toHaveLength(2);
    expect(listSource).toContain('queryError={tableQueryResult.isError}');
  });

  it('renders the show shell itself and localizes initial, refresh and error states', () => {
    expect(showSource).toContain('isLoading={false}');
    expect(showSource).not.toContain('isLoading={showLoading}');
    expect(showSource).toContain('<OrderShowProgressiveSurface');
    expect(showSource).toContain('state={orderShowLoading}');
    expect(showSource).toContain('queryError={queryResult.isError}');
    expect(showSource).toContain('sectionError={!useBackendOrdersRead && detailsError}');
    expect(showSource).toContain('onSectionRetry={() => { void refetchDetails(); }}');
    expect(progressiveSource).toContain("message: 'Не удалось загрузить состав заказа'");
    expect(progressiveSource).toContain("description: hasPrimaryData ? 'Показываем последние доступные данные.' : undefined");
    expect(showSource).toContain('moveCandidatesError ? (');
  });

  it('uses a shape skeleton for edit/create and keeps background refresh non-blocking', () => {
    expect(formSource).toContain('const isInitialLoading = isLoadingEssential');
    expect(formSource).toContain('const isRefreshing = !isInitialLoading');
    expect(formSource).toContain('<OrderFormProgressiveSurface');
    expect(formSource).toContain('state={formProgressiveLoading}');
    expect(progressiveSource).toContain('message: \'Не удалось обновить справочники формы\'');
    expect(formSource).toContain('onRetry={() => { void retryStatuses(); }}');
    expect(formSource).not.toContain("message: 'Ошибка загрузки справочников формы'");
    expect(formSource).not.toContain('<Spin size="large"');
  });

  it('does not add broad transitions or speculative compositor hints', () => {
    expect(progressiveSource).not.toMatch(/transition\s*:\s*all/i);
    expect(progressiveSource).not.toMatch(/will-change/i);
  });
});
