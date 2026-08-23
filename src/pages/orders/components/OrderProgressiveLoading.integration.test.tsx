import React, { useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', () => ({
  Alert: ({ message, description, action }: any) => (
    <div role="alert">
      <span>{message}</span>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  ),
  Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  Skeleton: () => <div data-skeleton="true" />,
  Space: ({ children }: any) => <div>{children}</div>,
  Typography: {
    Text: ({ children }: any) => <span>{children}</span>,
  },
}));

vi.mock('@ant-design/icons', () => ({
  LoadingOutlined: () => <span data-loading-icon="true" />,
}));

import {
  deriveOrderProgressiveLoadingState,
  OrderFormProgressiveSurface,
  OrderListProgressiveSurface,
  OrderShowProgressiveSurface,
} from './OrderProgressiveLoading';

interface QueryTransition<T> {
  data: T | null;
  pending: boolean;
  fetching: boolean;
  error: string | null;
}

describe('order progressive rendered transitions', () => {
  it('keeps list rows mounted through refresh/error and exposes local retry', () => {
    const retry = vi.fn();
    const mounts = vi.fn();
    const unmounts = vi.fn();
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(renderListScenario({
        data: null,
        pending: true,
        fetching: true,
        error: null,
      }, retry, <RetainedContent kind="list" mounts={mounts} unmounts={unmounts}>Заказ 42</RetainedContent>));
    });
    expect(renderer.root.findAllByProps({ 'data-skeleton': 'true' }).length).toBeGreaterThan(0);
    expect(mounts).not.toHaveBeenCalled();

    act(() => {
      renderer.update(renderListScenario({
        data: ['Заказ 42'],
        pending: false,
        fetching: false,
        error: null,
      }, retry, <RetainedContent kind="list" mounts={mounts} unmounts={unmounts}>Заказ 42</RetainedContent>));
    });
    act(() => {
      renderer.update(renderListScenario({
        data: ['Заказ 42'],
        pending: false,
        fetching: true,
        error: null,
      }, retry, <RetainedContent kind="list" mounts={mounts} unmounts={unmounts}>Заказ 42</RetainedContent>));
    });
    act(() => {
      renderer.update(renderListScenario({
        data: ['Заказ 42'],
        pending: false,
        fetching: false,
        error: 'list failed',
      }, retry, <RetainedContent kind="list" mounts={mounts} unmounts={unmounts}>Заказ 42</RetainedContent>));
    });

    expect(renderer.root.findByProps({ 'data-retained-kind': 'list' }).children).toContain('Заказ 42');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(retry).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('keeps stale show content mounted when background refresh fails', () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const retry = vi.fn();
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(renderShowScenario({
        data: { id: 42 },
        pending: false,
        fetching: false,
        error: null,
      }, retry, <RetainedContent kind="show" mounts={mounts} unmounts={unmounts}>Карточка 42</RetainedContent>));
    });
    act(() => {
      renderer.update(renderShowScenario({
        data: { id: 42 },
        pending: false,
        fetching: true,
        error: null,
      }, retry, <RetainedContent kind="show" mounts={mounts} unmounts={unmounts}>Карточка 42</RetainedContent>));
    });
    act(() => {
      renderer.update(renderShowScenario({
        data: { id: 42 },
        pending: false,
        fetching: false,
        error: 'show failed',
      }, retry, <RetainedContent kind="show" mounts={mounts} unmounts={unmounts}>Карточка 42</RetainedContent>));
    });

    expect(renderer.root.findByProps({ 'data-retained-kind': 'show' }).children).toContain('Карточка 42');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(retry).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('keeps stale show details mounted and retries the legacy section owner', () => {
    const retryPrimary = vi.fn();
    const retrySection = vi.fn();
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const retainedDetails = (
      <RetainedContent kind="show" mounts={mounts} unmounts={unmounts}>
        Деталь 7
      </RetainedContent>
    );
    const query = {
      data: { id: 42 },
      pending: false,
      fetching: false,
      error: null,
    };
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(renderShowScenario(query, retryPrimary, retainedDetails, {
        sectionPending: false,
        sectionError: false,
        retrySection,
      }));
    });
    act(() => {
      renderer.update(renderShowScenario(query, retryPrimary, retainedDetails, {
        sectionPending: true,
        sectionError: false,
        retrySection,
      }));
    });
    act(() => {
      renderer.update(renderShowScenario(query, retryPrimary, retainedDetails, {
        sectionPending: false,
        sectionError: true,
        retrySection,
      }));
    });

    expect(renderer.root.findByProps({ 'data-retained-kind': 'show' }).children).toContain('Деталь 7');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(retrySection).toHaveBeenCalledOnce();
    expect(retryPrimary).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('preserves form draft and focused-child state through refresh/error', () => {
    const retry = vi.fn();
    const mounts = vi.fn();
    const unmounts = vi.fn();
    let renderer!: ReactTestRenderer;
    const form = (transition: QueryTransition<{ id: number }>) => renderFormScenario(
      transition,
      retry,
      <DraftProbe mounts={mounts} unmounts={unmounts} />,
    );

    act(() => {
      renderer = create(form({
        data: { id: 42 },
        pending: false,
        fetching: false,
        error: null,
      }));
    });
    const input = renderer.root.findByType('input');
    act(() => input.props.onChange({ target: { value: 'несохранённый черновик' } }));
    act(() => input.props.onFocus());

    act(() => {
      renderer.update(form({
        data: { id: 42 },
        pending: false,
        fetching: true,
        error: null,
      }));
    });
    act(() => {
      renderer.update(form({
        data: { id: 42 },
        pending: false,
        fetching: false,
        error: 'references failed',
      }));
    });

    const retainedInput = renderer.root.findByType('input');
    expect(retainedInput.props.value).toBe('несохранённый черновик');
    expect(retainedInput.props['data-focused']).toBe(true);
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    act(() => renderer.root.findByType('button').props.onClick());
    expect(retry).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
});

function loadingState<T>(query: QueryTransition<T>, sectionPending = false) {
  return deriveOrderProgressiveLoadingState({
    hasPrimaryData: query.data !== null,
    primaryPending: query.pending,
    primaryFetching: query.fetching,
    sectionPending,
  });
}

function renderListScenario<T>(
  query: QueryTransition<T>,
  retry: () => void,
  children: React.ReactNode,
) {
  return (
    <OrderListProgressiveSurface
      state={loadingState(query)}
      hasPrimaryData={query.data !== null}
      queryError={query.error !== null}
      onRetry={retry}
    >
      {children}
    </OrderListProgressiveSurface>
  );
}

function renderShowScenario<T>(
  query: QueryTransition<T>,
  retry: () => void,
  children: React.ReactNode,
  options: {
    sectionPending?: boolean;
    sectionError?: boolean;
    retrySection?: () => void;
  } = {},
) {
  return (
    <OrderShowProgressiveSurface
      state={loadingState(query, options.sectionPending)}
      hasDeletedOrder={false}
      hasPrimaryData={query.data !== null}
      queryError={query.error !== null}
      sectionError={options.sectionError ?? false}
      onRetry={retry}
      onSectionRetry={options.retrySection ?? retry}
    >
      {children}
    </OrderShowProgressiveSurface>
  );
}

function renderFormScenario<T>(
  query: QueryTransition<T>,
  retry: () => void,
  children: React.ReactNode,
) {
  return (
    <OrderFormProgressiveSurface
      state={loadingState(query)}
      error={query.error ? new Error(query.error) : null}
      onRetry={retry}
    >
      {children}
    </OrderFormProgressiveSurface>
  );
}

function RetainedContent({
  kind,
  mounts,
  unmounts,
  children,
}: {
  kind: 'list' | 'show';
  mounts: () => void;
  unmounts: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    mounts();
    return unmounts;
  }, [mounts, unmounts]);
  return <section data-retained-kind={kind}>{children}</section>;
}

function DraftProbe({ mounts, unmounts }: { mounts: () => void; unmounts: () => void }) {
  const [value, setValue] = useState('исходное значение');
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    mounts();
    return unmounts;
  }, [mounts, unmounts]);
  return (
    <input
      value={value}
      data-focused={focused}
      onChange={(event) => setValue(event.target.value)}
      onFocus={() => setFocused(true)}
    />
  );
}
