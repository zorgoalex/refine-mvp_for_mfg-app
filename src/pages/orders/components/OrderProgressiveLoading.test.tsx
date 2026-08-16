import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  deriveOrderProgressiveLoadingState,
  OrderInitialSkeleton,
  OrderNonBlockingLoadingStatus,
} from './OrderProgressiveLoading';

describe('order progressive loading', () => {
  it('separates initial, background and section loading', () => {
    expect(deriveOrderProgressiveLoadingState({
      hasPrimaryData: false,
      primaryPending: true,
      primaryFetching: true,
    })).toEqual({
      isInitialLoading: true,
      isRefreshing: false,
      isSectionLoading: false,
    });
    expect(deriveOrderProgressiveLoadingState({
      hasPrimaryData: true,
      primaryPending: false,
      primaryFetching: true,
      sectionPending: true,
    })).toEqual({
      isInitialLoading: false,
      isRefreshing: true,
      isSectionLoading: true,
    });
  });

  it('uses one explicit status for initial skeleton and reserves stable height', () => {
    const html = renderToStaticMarkup(
      <OrderInitialSkeleton variant="list" label="Загрузка заказов" />,
    );
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('min-height:620px');
  });

  it('announces only an active non-blocking refresh without removing its layout slot', () => {
    const idle = renderToStaticMarkup(
      <OrderNonBlockingLoadingStatus active={false} label="Обновляем" />,
    );
    const active = renderToStaticMarkup(
      <OrderNonBlockingLoadingStatus active label="Обновляем" />,
    );
    expect(idle).not.toContain('role="status"');
    expect(idle).toContain('min-height:24px');
    expect(active.match(/role="status"/g)).toHaveLength(1);
    expect(active).toContain('Обновляем');
    expect(active).not.toContain('autofocus');
  });
});
