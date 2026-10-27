import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClientScreenBoundary } from './ClientScreenOrderHeader';

describe('customer screen error boundary in the order header', () => {
  it('switches to the failed state on a render error of its subtree', () => {
    expect(ClientScreenBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('shows the children normally, and after a failure a notice with a way back instead of nothing', () => {
    const child = <span>кнопки экрана клиента</span>;
    expect(renderToStaticMarkup(<ClientScreenBoundary>{child}</ClientScreenBoundary>)).toContain('кнопки экрана клиента');

    const boundary = new ClientScreenBoundary({ children: child });
    boundary.state = { failed: true };
    const fallback = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(fallback).toContain('Экран клиента отключён из-за ошибки');
    expect(fallback).toContain('Включить снова');
    expect(fallback).not.toContain('кнопки экрана клиента');
  });

  it('retry leaves the failed state', () => {
    const boundary = new ClientScreenBoundary({ children: null });
    let next: { failed: boolean } | null = null;
    boundary.setState = ((state: { failed: boolean }) => { next = state; }) as typeof boundary.setState;
    boundary.retry();
    expect(next).toEqual({ failed: false });
  });
});
